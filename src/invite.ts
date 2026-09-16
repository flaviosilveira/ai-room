import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  INSTALL_HINT,
  detectMultiplexer,
  ensureWorkspace,
  sessionExists,
  sessionName,
  startSession,
  workspaceName,
} from "./session.js";
import type { MultiplexerDriver, PaneSpec, WorkspaceResult } from "./session.js";

export interface AgentLauncher {
  bin: string;
  /**
   * argv for an INTERACTIVE run seeded with `prompt`. Interactive is the point:
   * a headless run resolves its own approval prompts, so attaching to it later
   * would leave the human nothing to answer.
   */
  args: (prompt: string) => string[];
}

export const LAUNCHERS: Record<string, AgentLauncher> = {
  claude: { bin: "claude", args: (prompt) => [prompt] },
  codex: { bin: "codex", args: (prompt) => [prompt] },
  agy: { bin: "agy", args: (prompt) => ["-i", prompt] },
};

/**
 * Deliberately minimal. The charter is the source of the collaboration, so the
 * seed prompt only says how to go get it — it never restates the brief, roles,
 * conventions or tools. Duplicating them here would let the two drift apart.
 */
export function joinPrompt(room: string, agent: string): string {
  return [
    `Join the ai-room "${room}" as agent "${agent}" by calling room_join`,
    `with {room: "${room}", agent: "${agent}"}.`,
    "Read the briefing in the response and follow it.",
    "Then call room_wait and stay in that loop.",
    "If a human talks to you here, answer them and then call room_wait again;",
    "that is not leaving the room. Only room_leave ends your participation.",
  ].join(" ");
}

export function agentCommand(room: string, agent: string, launcherName = agent): string[] | null {
  const launcher = LAUNCHERS[launcherName];
  if (!launcher) return null;
  return [launcher.bin, ...launcher.args(joinPrompt(room, agent))];
}

export function onPath(bin: string): boolean {
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
 * How the monitor pane should invoke ai-room. A globally installed `ai-room` is
 * preferred, but a repo checkout has none on PATH, so fall back to running this
 * very CLI with the current node binary. Without this the monitor pane starts a
 * command that does not exist.
 */
export function monitorCommand(room: string): string[] {
  if (onPath("ai-room")) return ["ai-room", "console", room];
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  return [process.execPath, cli, "console", room];
}

export function logDir(): string {
  return process.env.AI_ROOM_LOG_DIR || path.join(os.homedir(), ".ai-room", "logs");
}

export type InviteMode = "workspace" | "session" | "headless";

export interface InviteResult {
  agent: string;
  command: string;
  status: "launched" | "missing" | "failed" | "skipped";
  mode?: InviteMode;
  session?: string;
  attachWith?: string;
  logPath?: string;
  error?: string;
}

/* ------------------------------------------------- per-agent session mode */

export function invite(
  room: string,
  agent: string,
  options: { launcher?: string; cwd?: string; dryRun?: boolean; driver?: MultiplexerDriver | null } = {}
): InviteResult {
  const argv = agentCommand(room, agent, options.launcher ?? agent);
  if (!argv) {
    return {
      agent,
      command: "",
      status: "failed",
      error: `No launcher for "${options.launcher ?? agent}". Known: ${Object.keys(LAUNCHERS).join(", ")}.`,
    };
  }

  const command = argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
  const session = sessionName(room, agent);
  if (options.dryRun) {
    return { agent, command, status: "launched", mode: "session", session };
  }
  if (!onPath(argv[0])) {
    return { agent, command, status: "missing", error: `${argv[0]} is not on PATH.` };
  }

  const driver = options.driver !== undefined ? options.driver : detectMultiplexer();
  const cwd = options.cwd ?? process.cwd();

  // No multiplexer at all: still launch, just without an attachable TTY. The
  // room must keep working on a machine with neither tmux nor screen.
  if (!driver) return headless(room, agent, argv, command, cwd);

  if (sessionExists(driver, session)) {
    return {
      agent,
      command,
      status: "skipped",
      mode: "session",
      session,
      attachWith: driver.attach(session),
      error: `Session "${session}" already exists; left running.`,
    };
  }

  try {
    const started = startSession(driver, session, cwd, argv);
    return {
      agent,
      command,
      status: "launched",
      mode: "session",
      session: started.session,
      attachWith: started.attachWith,
    };
  } catch (error) {
    return { agent, command, status: "failed", session, error: error instanceof Error ? error.message : String(error) };
  }
}

function headless(
  room: string,
  agent: string,
  argv: string[],
  command: string,
  cwd: string
): InviteResult {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${room}-${agent}.log`);
  const out = fs.openSync(logPath, "a");
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    return { agent, command, status: "launched", mode: "headless", logPath };
  } catch (error) {
    return { agent, command, status: "failed", mode: "headless", logPath, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.closeSync(out);
  }
}

/* ------------------------------------------------------- workspace mode */

export interface WorkspacePlan {
  agents: string[];
  missing: string[];
  panes: PaneSpec[];
}

/**
 * Builds the pane list: one per agent that is actually installed, plus a monitor
 * pane running the room console. The monitor is just another frontend client —
 * it talks to the server over HTTP and holds no coordination state of its own.
 */
export function planWorkspace(
  room: string,
  agents: string[],
  options: { monitor?: boolean; monitorCommand?: string[] } = {}
): WorkspacePlan {
  const panes: PaneSpec[] = [];
  const missing: string[] = [];
  const launched: string[] = [];

  for (const agent of agents) {
    const argv = agentCommand(room, agent);
    if (!argv || !onPath(argv[0])) {
      missing.push(agent);
      continue;
    }
    panes.push({ title: agent, command: argv });
    launched.push(agent);
  }

  if (options.monitor !== false) {
    panes.push({
      title: "monitor",
      command: options.monitorCommand ?? monitorCommand(room),
    });
  }

  return { agents: launched, missing, panes };
}

export function openWorkspace(
  room: string,
  agents: string[],
  options: { cwd?: string; monitorCommand?: string[]; monitor?: boolean } = {}
): { plan: WorkspacePlan; result: WorkspaceResult } {
  const driver = detectMultiplexer("tmux");
  if (!driver) throw new Error(`tmux is required for the pane workspace. ${INSTALL_HINT}`);
  const plan = planWorkspace(room, agents, options);
  const result = ensureWorkspace(driver, workspaceName(room), options.cwd ?? process.cwd(), plan.panes);
  return { plan, result };
}
