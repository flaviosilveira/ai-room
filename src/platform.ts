import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const isWsl = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);

/**
 * WSL appends the Windows PATH, whose npm shims (`claude`, `codex`) pass an
 * executable check but are Windows programs, and every lookup there crosses the
 * slow /mnt mount. Only `.exe` tools such as clip.exe are taken from Windows.
 */
export function pathDirs(bin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const skipWindows = isWsl(env) && !bin.endsWith(".exe");
  return (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !(skipWindows && dir.startsWith("/mnt/")));
}

export function onPath(bin: string): boolean {
  return pathDirs(bin).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Claude Code moves all of ~/.claude, ~/.claude.json included, under CLAUDE_CONFIG_DIR when it is set. */
export const claudeDir = (home = os.homedir()) => process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

export const claudeJson = (home = os.homedir()) =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");

export const codexDir = (home = os.homedir()) => process.env.CODEX_HOME || path.join(home, ".codex");
