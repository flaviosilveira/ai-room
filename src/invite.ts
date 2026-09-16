import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentLauncher {
  /** Binary to look for on PATH. */
  bin: string;
  /** Build argv for a seeded, non-interactive run. */
  args: (prompt: string) => string[];
}

/**
 * Every supported harness can be started with a seed prompt. They differ in how
 * long they stay alive: `codex exec` and `claude -p` run the agentic loop until
 * the model stops calling tools, which — with room_wait holding server-side —
 * means they keep listening. `agy -i` seeds an interactive session instead.
 */
export const LAUNCHERS: Record<string, AgentLauncher> = {
  claude: { bin: "claude", args: (prompt) => ["-p", prompt] },
  codex: { bin: "codex", args: (prompt) => ["exec", "--skip-git-repo-check", prompt] },
  agy: { bin: "agy", args: (prompt) => ["-p", prompt] },
};

export function joinPrompt(room: string, agent: string): string {
  return [
    `Join the ai-room "${room}" as agent "${agent}" by calling room_join`,
    `with {room: "${room}", agent: "${agent}"}.`,
    "The response contains your briefing: read briefing.brief, briefing.you,",
    "briefing.teammates, briefing.conventions and briefing.tools, and follow all of it.",
    "Introduce yourself with room_send, then call room_wait and stay in that loop.",
    "When room_wait returns status 'timeout', call it again and emit no text.",
  ].join(" ");
}

export interface InviteResult {
  agent: string;
  launcher: string;
  command: string;
  status: "launched" | "missing" | "failed";
  pid?: number;
  logPath?: string;
  error?: string;
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function logDir(): string {
  return process.env.AI_ROOM_LOG_DIR || path.join(os.homedir(), ".ai-room", "logs");
}

/**
 * Launches one agent detached, with stdout and stderr going to a per-invite log
 * file. Detached so the agents outlive the `ai-room open` process that spawned
 * them; the human stays in their own terminal.
 */
export function invite(
  room: string,
  agent: string,
  options: { launcher?: string; cwd?: string; dryRun?: boolean } = {}
): InviteResult {
  const launcherName = options.launcher ?? agent;
  const launcher = LAUNCHERS[launcherName];
  if (!launcher) {
    return {
      agent,
      launcher: launcherName,
      command: "",
      status: "failed",
      error: `No launcher for "${launcherName}". Known: ${Object.keys(LAUNCHERS).join(", ")}.`,
    };
  }

  const prompt = joinPrompt(room, agent);
  const args = launcher.args(prompt);
  const command = `${launcher.bin} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;

  if (options.dryRun) {
    return { agent, launcher: launcherName, command, status: "launched" };
  }
  if (!onPath(launcher.bin)) {
    return {
      agent,
      launcher: launcherName,
      command,
      status: "missing",
      error: `${launcher.bin} is not on PATH.`,
    };
  }

  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${room}-${agent}-${Date.now()}.log`);
  const out = fs.openSync(logPath, "a");

  try {
    const child = spawn(launcher.bin, args, {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    return { agent, launcher: launcherName, command, status: "launched", pid: child.pid, logPath };
  } catch (error) {
    return {
      agent,
      launcher: launcherName,
      command,
      status: "failed",
      logPath,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.closeSync(out);
  }
}
