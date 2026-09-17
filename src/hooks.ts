import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hook wiring is per harness, but the contract is the same one both implement:
 * a PreToolUse command hook reads the event on stdin and may answer with
 * `hookSpecificOutput.additionalContext`. ai-room only ships the script and
 * says where it goes — installing is the human's call, and on Codex it also
 * needs that human to trust the hook once.
 */
export type Harness = "claude" | "codex";

export interface HookInstall {
  harness: Harness;
  configPath: string;
  event: "PreToolUse";
  command: string;
  installed: boolean;
  /** Extra step the harness imposes before the hook can run. */
  note?: string;
}

/**
 * The installed command is the shell wrapper, not the Python hook. It answers
 * the one question that does not need an interpreter — is this session in a
 * room at all — and only then pays for Python. Harness sessions that have
 * nothing to do with ai-room are the common case, and they run this on every
 * tool call.
 */
/**
 * Codex hashes a hook and refuses to run it until a human approves that exact
 * hash. `installed` therefore says the config names the hook, never that Codex
 * will run it: Codex exposes no documented way to read trust state, so ai-room
 * does not guess at one.
 */
export const CODEX_TRUST_NOTE =
  "Codex asks a human to trust this hook the first time it sees it, and skips it until then — " +
  "in the TUI it stops at a 'Hooks need review' prompt, so add it only when you can answer that once. " +
  "ai-room never approves it for you, and cannot tell whether you already did.";

export const UNREAD_HOOK = "ai-room-unread-hook.sh";
export const UNREAD_HOOK_PY = "ai-room-unread-hook.py";
export const STOP_HOOK = "ai-room-stop-hook.py";

export function hookPath(script: string): string {
  return fileURLToPath(new URL(`../hooks/${script}`, import.meta.url));
}

/** The hook path as a command string, safe for a path with spaces in it. */
export function hookCommand(script: string): string {
  const file = hookPath(script);
  return /[^A-Za-z0-9_@%+=:,./-]/.test(file) ? `'${file.replace(/'/g, `'\''`)}'` : file;
}

function configPath(harness: Harness): string {
  return harness === "claude"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(os.homedir(), ".codex", "hooks.json");
}

function isInstalled(file: string, script: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").includes(script);
  } catch {
    return false;
  }
}

export function hookStatus(): HookInstall[] {
  const command = hookCommand(UNREAD_HOOK);
  return (["claude", "codex"] as Harness[]).map((harness) => {
    const file = configPath(harness);
    return {
      harness,
      configPath: file,
      event: "PreToolUse",
      command,
      installed: isInstalled(file, UNREAD_HOOK),
      note: harness === "codex" ? CODEX_TRUST_NOTE : undefined,
    };
  });
}

/** The exact block to paste, shaped the way that harness reads it. */
export function hookSnippet(harness: Harness): string {
  const command = hookCommand(UNREAD_HOOK);
  const entry = {
    hooks: {
      PreToolUse: [{ matcher: harness === "claude" ? "*" : "", hooks: [{ type: "command", command }] }],
    },
  };
  return JSON.stringify(entry, null, 2);
}
