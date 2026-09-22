import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Attachments are files next to the database, never bytes inside a message.
 * A message carries their metadata; an agent that needs one opens it itself,
 * so a screenshot costs context only to the agents that actually look at it.
 */
export const MAX_ATTACHMENT_BYTES = Number(process.env.AI_ROOM_ATTACHMENT_MAX_BYTES ?? 10 * 1024 * 1024);
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export interface SniffedType {
  mime: string;
  ext: string;
  kind: "image" | "pdf" | "text";
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "log", "json", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "css",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "php",
  "sh", "zsh", "sql", "diff", "patch", "env", "ini", "conf",
]);

const TEXT_MIME: Record<string, string> = {
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/plain",
  xml: "text/plain",
};

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * The type comes from the bytes, never from the name: a file called
 * screenshot.png that is really a script stays a script. SVG is refused on
 * purpose — it is an image that can carry code.
 */
export function sniffType(bytes: Buffer, name = ""): SniffedType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png", kind: "image" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return { mime: "image/gif", ext: "gif", kind: "image" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { mime: "image/webp", ext: "webp", kind: "image" };
  if (startsWith(bytes, ascii("%PDF-"))) return { mime: "application/pdf", ext: "pdf", kind: "pdf" };
  if (isText(bytes)) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const safe = TEXT_EXTENSIONS.has(ext) ? ext : "txt";
    return { mime: TEXT_MIME[safe] ?? "text/plain", ext: safe, kind: "text" };
  }
  return null;
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Width and height from the header alone, for the formats that make it cheap. */
export function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === "image/gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        // SOF0..SOF15, minus the DHT/JPG/DAC markers that share the range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    /* a truncated header just has no size */
  }
  return null;
}

export function attachmentRoot(): string {
  return process.env.AI_ROOM_ATTACHMENT_DIR || path.join(os.homedir(), ".ai-room", "attachments");
}

/** Content-addressed, so the same screenshot pasted twice is stored once. */
export function blobPath(sha256: string, ext: string, root = attachmentRoot()): string {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new Error("invalid attachment identity");
  }
  return path.join(root, sha256.slice(0, 2), `${sha256}.${ext}`);
}

/** What the human called it, reduced to something that is only ever displayed. */
export function displayName(name: string | undefined, fallback: string): string {
  const base = path.basename(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return base || fallback;
}

function insideGitRepo(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/**
 * Pointing AI_ROOM_ATTACHMENT_DIR into a workspace is allowed, for a harness
 * that can only read its own tree, but a screenshot must never end up in a
 * commit by accident.
 */
function guardRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore) && insideGitRepo(root)) fs.writeFileSync(ignore, "*\n");
}

export interface StoredBlob {
  sha256: string;
  mime: string;
  ext: string;
  kind: SniffedType["kind"];
  bytes: number;
  width: number | null;
  height: number | null;
  path: string;
}

export function storeBlob(bytes: Buffer, name = "", root = attachmentRoot()): StoredBlob {
  if (!bytes.length) throw new Error("attachment is empty");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment is ${bytes.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
  }
  const type = sniffType(bytes, name);
  if (!type) throw new Error("unsupported attachment type: png, jpeg, gif, webp, pdf or UTF-8 text");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = blobPath(sha256, type.ext, root);
  guardRoot(root);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Written aside and renamed, so a reader never sees half a file.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  }
  const size = type.kind === "image" ? imageSize(bytes, type.mime) : null;
  return {
    sha256,
    mime: type.mime,
    ext: type.ext,
    kind: type.kind,
    bytes: bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
    path: file,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Reads a stored file back, refusing anything that is not a plain file inside
 * the store: a symlink planted there must not turn the attachment tool into a
 * way to read the rest of the disk.
 */
export function readStoredFile(file: string, root = attachmentRoot()): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("attachment is not a regular file");
  const real = fs.realpathSync(file);
  const realRoot = fs.realpathSync(root);
  if (!real.startsWith(realRoot + path.sep)) throw new Error("attachment is outside the attachment store");
  return fs.readFileSync(real);
}

/** Harnesses whose own file tools show an image to the model without help. */
export const NATIVE_IMAGE_VIEWERS: Record<string, string> = {
  claude: "Open it with your Read tool on the path; Read shows images and PDFs directly.",
  codex: "Open it with your view_image tool on the path.",
};

/** Larger images are left to the harness's own reader instead of the tool result. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
