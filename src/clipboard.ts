import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";

/**
 * A terminal paste carries text only, so an image never arrives through the
 * console's input. The console reads the clipboard itself instead — it runs on
 * the human's desktop, which also makes this work inside tmux.
 */
export type ClipboardResult =
  | { kind: "image"; bytes: Buffer; name: string }
  | { kind: "file"; path: string }
  | { kind: "text"; text: string }
  | { kind: "none"; reason: string };

type Run = (bin: string, args: string[]) => { status: number | null; stdout: Buffer };

const runBinary: Run = (bin, args) => {
  const result = spawnSync(bin, args, { maxBuffer: MAX_ATTACHMENT_BYTES + 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? Buffer.alloc(0) };
};

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const stampName = (ext: string) => `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;

function readMac(run: Run): ClipboardResult {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "airoom-clip-")), "clip.png");
  try {
    // The clipboard is asked what it holds before anything is coerced:
    // AppleScript turns plain text into a "file URL" on request, so text that
    // was only being pasted came back as a path to a file that does not exist.
    const script = [
      'set kinds to ""',
      "repeat with entry in (clipboard info)",
      "set kinds to kinds & ((item 1 of entry) as text) & \",\"",
      "end repeat",
      'if kinds contains "furl" then return "file:" & POSIX path of (the clipboard as «class furl»)',
      'if kinds contains "PNGf" or kinds contains "TIFF" then',
      "set d to (the clipboard as «class PNGf»)",
      `set f to open for access POSIX file ${JSON.stringify(out)} with write permission`,
      "set eof f to 0",
      "write d to f",
      "close access f",
      'return "image"',
      "end if",
      'if kinds contains "utf8" or kinds contains "string" then return "text"',
      'return ""',
    ];
    const answer = run("osascript", script.flatMap((line) => ["-e", line])).stdout.toString("utf8").trim();
    if (answer === "image" && fs.existsSync(out)) {
      return { kind: "image", bytes: fs.readFileSync(out), name: stampName("png") };
    }
    if (answer.startsWith("file:/")) return { kind: "file", path: answer.slice("file:".length) };
    if (answer === "text") return { kind: "text", text: run("pbpaste", []).stdout.toString("utf8") };
    return { kind: "none", reason: "the clipboard is empty" };
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function readLinux(run: Run, env: NodeJS.ProcessEnv, has: (bin: string) => boolean): ClipboardResult {
  const wayland = Boolean(env.WAYLAND_DISPLAY) && has("wl-paste");
  const x11 = Boolean(env.DISPLAY) && has("xclip");
  if (!wayland && !x11) {
    return {
      kind: "none",
      reason: env.WAYLAND_DISPLAY || env.DISPLAY
        ? "install wl-clipboard (Wayland) or xclip (X11) to paste images"
        : "no graphical session here (SSH?); attach the file with /file <path>",
    };
  }
  const list = wayland ? run("wl-paste", ["--list-types"]) : run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
  const offered = list.stdout.toString("utf8").split("\n").map((line) => line.trim());
  const type = IMAGE_TYPES.find((candidate) => offered.includes(candidate));
  if (!type) {
    if (!offered.some((kind) => kind.startsWith("text/") || kind === "UTF8_STRING")) {
      return { kind: "none", reason: "the clipboard is empty" };
    }
    const text = wayland ? run("wl-paste", ["--no-newline"]) : run("xclip", ["-selection", "clipboard", "-o"]);
    return { kind: "text", text: text.stdout.toString("utf8") };
  }
  const data = wayland
    ? run("wl-paste", ["--no-newline", "--type", type])
    : run("xclip", ["-selection", "clipboard", "-t", type, "-o"]);
  if (data.status !== 0 || !data.stdout.length) return { kind: "none", reason: "could not read the clipboard image" };
  return { kind: "image", bytes: data.stdout, name: stampName(type.split("/")[1].replace("jpeg", "jpg")) };
}

export function readClipboard(
  options: { platform?: string; env?: NodeJS.ProcessEnv; run?: Run; has?: (bin: string) => boolean } = {}
): ClipboardResult {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runBinary;
  if (platform === "darwin") return readMac(run);
  if (platform === "linux") return readLinux(run, options.env ?? process.env, options.has ?? onPath);
  return { kind: "none", reason: `clipboard images are not supported on ${platform}; use /file <path>` };
}

/**
 * A file dragged into a terminal arrives as its path, quoted or with escaped
 * spaces depending on the terminal. Only a paste that is exactly one existing
 * image or PDF counts; any other text stays text.
 */
export function pastedFilePath(text: string): string | null {
  let candidate = text.trim();
  if (!candidate || candidate.includes("\n")) return null;
  if (/^'.*'$/.test(candidate) || /^".*"$/.test(candidate)) candidate = candidate.slice(1, -1);
  else candidate = candidate.replace(/\\(.)/g, "$1");
  if (candidate.startsWith("file://")) candidate = decodeURI(candidate.slice("file://".length));
  if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2));
  if (!path.isAbsolute(candidate) || !/\.(png|jpe?g|gif|webp|pdf)$/i.test(candidate)) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * `/file` is the human pointing at their own file, so symlinks are followed;
 * what is read has to be a regular file within the size limit, checked before
 * a single byte is loaded.
 */
export function readAttachableFile(file: string): { bytes: Buffer; name: string } {
  const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
  const real = fs.realpathSync(path.resolve(expanded));
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file} is ${stat.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
  }
  return { bytes: fs.readFileSync(real), name: path.basename(real) };
}
