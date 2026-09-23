import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookStatus } from "./hooks.js";
import { LAUNCHERS, filesCommand, onPath } from "./invite.js";
import { TOOL_CHECKS, toolInstalled } from "./presets.js";
import { detectMultiplexer } from "./session.js";

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
  add({
    section: "server",
    name: "tmux",
    level: detectMultiplexer("tmux") ? "ok" : "warn",
    detail: detectMultiplexer("tmux") ? "pane workspace available" : "not installed; agents run detached",
    fix: detectMultiplexer("tmux") ? undefined : process.platform === "darwin" ? "brew install tmux" : "sudo apt install tmux",
  });

  for (const [harness, launcher] of Object.entries(LAUNCHERS)) {
    const present = onPath(launcher.bin);
    add({ section: "agents", name: harness, level: present ? "ok" : "warn", detail: present ? "on PATH" : "not installed" });
  }
  checks.push(...mcpChecks(home, port));
  for (const hook of hookStatus()) {
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
    fix: browser ? undefined : "brew install yazi",
  });
  const clipboard =
    process.platform === "darwin" ? onPath("osascript") : onPath("wl-paste") || onPath("xclip");
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
