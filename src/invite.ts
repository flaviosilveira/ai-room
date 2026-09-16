import fs from "node:fs";
import path from "node:path";
import {
  INSTALL_HINT,
  detectMultiplexer,
  sessionExists,
  sessionName,
  startSession,
} from "./session.js";

export interface AgentLauncher {
  /** Binary to look for on PATH. */
  bin: string;
  /**
   * argv for an INTERACTIVE run seeded with `prompt`. Interactive matters: it is
   * what makes the harness's own approval prompt exist, so a human can attach to
   * the session and answer it instead of the approval being auto-resolved.
   */
  args: (prompt: string) => string[];
}

/**
 * Every supported harness can be started with a seed prompt. They differ in how
 * long they stay alive: `codex exec` and `claude -p` run the agentic loop until
 * the model stops calling tools, which — with room_wait holding server-side —
 * means they keep listening. `agy -i` seeds an interactive session instead.
 */
export const LAUNCHERS: Record<string, AgentLauncher> = {
  claude: { bin: "claude", args: (prompt) => [prompt] },
  codex: { bin: "codex", args: (prompt) => [prompt] },
  agy: { bin: "agy", args: (prompt) => ["-i", prompt] },
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
  session?: string;
  attachWith?: string;
  multiplexer?: string;
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

/**
 * Starts one agent in a detached multiplexer session. Detached so the human
 * stays in a single console window; a session rather than a log file so they
 * can attach to any agent later, without having predicted at launch time which
 * one would end up needing attention.
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

  const argv = [launcher.bin, ...launcher.args(joinPrompt(room, agent))];
  const command = argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
  const session = sessionName(room, agent);

  if (options.dryRun) {
    return { agent, launcher: launcherName, command, status: "launched", session };
  }

  const driver = detectMultiplexer();
  if (!driver) {
    return { agent, launcher: launcherName, command, status: "failed", error: `No tmux or screen on PATH. ${INSTALL_HINT}` };
  }
  if (!onPath(launcher.bin)) {
    return { agent, launcher: launcherName, command, status: "missing", error: `${launcher.bin} is not on PATH.` };
  }
  if (sessionExists(driver, session)) {
    return {
      agent,
      launcher: launcherName,
      command,
      status: "failed",
      session,
      attachWith: driver.attach(session),
      error: `Session "${session}" already exists. Attach to it, or kill it first.`,
    };
  }

  try {
    const started = startSession(driver, session, options.cwd ?? process.cwd(), argv);
    return {
      agent,
      launcher: launcherName,
      command,
      status: "launched",
      session: started.session,
      attachWith: started.attachWith,
      multiplexer: started.multiplexer,
    };
  } catch (error) {
    return {
      agent,
      launcher: launcherName,
      command,
      status: "failed",
      session,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
