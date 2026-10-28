import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_NAMES } from "./catalog.js";
import { hookStatus } from "./hooks.js";
import { LAUNCHERS, filesCommand, onPath } from "./invite.js";
import { TOOL_CHECKS, toolInstalled } from "./presets.js";
import { detectMultiplexer, clipboardCommand } from "./session.js";

/**
 * One read-only look at everything ai-room depends on, with the command that
 * fixes each gap. It installs nothing: plugins and hooks change each agent's
 * own configuration, which is the human's call.
 */
export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  section: string;
  name: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** Where each harness keeps its MCP servers, and how to add ai-room there. */
function mcpChecks(home: string, port: number): Check[] {
  const url = `http://127.0.0.1:${port}/mcp`;
  const configs: { harness: string; file: string; fix: string }[] = [
    { harness: "claude", file: path.join(home, ".claude.json"), fix: `claude mcp add --transport http ai-room ${url}` },
    {
      harness: "codex",
      file: path.join(home, ".codex", "config.toml"),
      fix: `add to ~/.codex/config.toml: [mcp_servers.ai-room] url = "${url}"`,
    },
    {
      harness: "agy",
      file: path.join(home, ".gemini", "config", "mcp_config.json"),
      fix: `add to ~/.gemini/config/mcp_config.json: {"mcpServers": {"ai-room": {"serverUrl": "${url}"}}}`,
    },
  ];
  return configs
    .filter(({ harness }) => onPath(LAUNCHERS[harness].bin))
    .map(({ harness, file, fix }) => {
      const registered = read(file).includes("ai-room");
      return {
        section: "agents",
        name: `${harness} MCP`,
        level: registered ? "ok" : "fail",
        detail: registered ? "ai-room registered" : "ai-room not registered",
        fix: registered ? undefined : fix,
      };
    });
}

/**
 * Codex approves ai-room's tools one by one once the human picks "Always allow",
 * so a tool added by an upgrade asks again. Only reported for those who approve
 * per tool; anyone else is asked every time anyway.
 */
export function codexToolApprovals(config: string): Check | null {
  const approved = new Set([...config.matchAll(/^\[mcp_servers\.ai-room\.tools\.([\w-]+)\]/gm)].map((match) => match[1]));
  if (!approved.size) return null;
  const missing = TOOL_NAMES.filter((name) => !approved.has(name));
  return {
    section: "agents",
    name: "codex approvals",
    level: missing.length ? "warn" : "ok",
    detail: missing.length ? `asks before ${missing.join(", ")}` : "every ai-room tool approved",
    fix: missing.length
      ? `add to ~/.codex/config.toml: ${missing.map((name) => `[mcp_servers.ai-room.tools.${name}] approval_mode = "approve"`).join(" ")}`
      : undefined,
  };
}

/** Pane sizes in percent (`split-window -l 50%`) arrived in tmux 3.1. */
export function tmuxTooOld(version: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major < 3 || (major === 3 && minor < 1);
}

export async function runChecks(port: number, home = os.homedir()): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  let health: { version?: string } | null = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) health = (await response.json()) as { version?: string };
  } catch {
    /* reported below */
  }
  add({
    section: "server",
    name: "server",
    level: health ? "ok" : "fail",
    detail: health ? `answering on port ${port} (${health.version ?? "unknown version"})` : `nothing answering on port ${port}`,
    fix: health ? undefined : "ai-room service install",
  });
  const tmux = detectMultiplexer("tmux");
  const tmuxVersion = tmux ? spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout?.trim() ?? "" : "";
  const tmuxOld = tmuxTooOld(tmuxVersion);
  add({
    section: "server",
    name: "tmux",
    level: tmux && !tmuxOld ? "ok" : "warn",
    detail: !tmux ? "not installed; agents run detached" : tmuxOld ? `${tmuxVersion}: the pane workspace needs tmux 3.1 or later` : "pane workspace available",
    fix: tmux && !tmuxOld ? undefined : process.platform === "darwin" ? "brew install tmux" : "install tmux 3.1 or later (Ubuntu 22.04+ ships it: sudo apt install tmux)",
  });

  for (const [harness, launcher] of Object.entries(LAUNCHERS)) {
    const present = onPath(launcher.bin);
    add({ section: "agents", name: harness, level: present ? "ok" : "warn", detail: present ? "on PATH" : "not installed" });
  }
  checks.push(...mcpChecks(home, port));
  const approvals = codexToolApprovals(read(path.join(home, ".codex", "config.toml")));
  if (approvals) add(approvals);
  const hooks = hookStatus();
  if (hooks.some((hook) => hook.installed)) {
    const python = process.env.AI_ROOM_PYTHON || "python3";
    const found = path.isAbsolute(python) ? fs.existsSync(python) : onPath(python);
    add({
      section: "agents",
      name: "python for hooks",
      level: found ? "ok" : "fail",
      detail: found ? python : `${python} not found: the hooks let every call through`,
      fix: found ? undefined : process.platform === "darwin" ? "xcode-select --install" : "sudo apt install python3",
    });
  }
  for (const hook of hooks) {
    add({
      section: "agents",
      name: `${hook.harness} unread hook`,
      level: hook.installed ? "ok" : "warn",
      detail: hook.installed ? "installed" : "not installed",
      fix: hook.installed ? undefined : "ai-room hooks",
    });
  }

  for (const [name, check] of Object.entries(TOOL_CHECKS)) {
    const installed = toolInstalled(name, { home }) === true;
    add({ section: "tools", name, level: installed ? "ok" : "warn", detail: installed ? "installed" : "not installed", fix: installed ? undefined : check.install });
  }

  const browser = filesCommand();
  add({
    section: "workspace",
    name: "files tab",
    level: browser ? "ok" : "warn",
    detail: browser ? browser[0] : "no file browser",
    fix: browser ? undefined : process.platform === "darwin" ? "brew install yazi" : "install yazi (https://yazi-rs.github.io) or nnn",
  });
  const copyTo = clipboardCommand();
  add({
    section: "workspace",
    name: "copy from panes",
    level: copyTo ? "ok" : "warn",
    detail: copyTo ? `selection goes to \`${copyTo}\`` : "relies on the terminal supporting OSC 52",
    fix: copyTo ? undefined : "install wl-clipboard (Wayland) or xclip (X11)",
  });
  const clipboard =
    process.platform === "darwin" ? onPath("osascript") : ((process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) && onPath("powershell.exe")) || onPath("wl-paste") || onPath("xclip");
  add({
    section: "workspace",
    name: "clipboard images",
    level: clipboard ? "ok" : "warn",
    detail: clipboard ? "available" : "no clipboard tool",
    fix: clipboard ? undefined : "install wl-clipboard (Wayland) or xclip (X11)",
  });
  const settings = read(path.join(home, ".claude", "settings.json"));
  const readable = settings.includes(path.join(home, ".ai-room", "attachments")) || settings.includes("~/.ai-room/attachments");
  if (onPath("claude")) {
    add({
      section: "workspace",
      name: "attachments for claude",
      level: readable ? "ok" : "warn",
      detail: readable ? "readable without a prompt" : "Claude asks before reading each attachment",
      fix: readable ? undefined : 'add "~/.ai-room/attachments" to permissions.additionalDirectories in ~/.claude/settings.json',
    });
  }
  return checks;
}

const MARK: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };

export function renderChecks(checks: Check[]): string {
  const lines: string[] = [];
  let section = "";
  for (const check of checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push(`${lines.length ? "\n" : ""}${section}`);
    }
    lines.push(`  ${MARK[check.level]} ${check.name.padEnd(24)} ${check.detail}`);
    if (check.fix) lines.push(`    → ${check.fix}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  lines.push(`\n${failed ? `${failed} problem(s)` : "no problems"}${warned ? `, ${warned} optional item(s) missing` : ""}.`);
  return lines.join("\n");
}
