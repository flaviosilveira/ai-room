import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Terminal multiplexing is a FRONTEND concern: it exists so a human can talk to
 * each agent directly. It is never part of the MCP protocol, and `ai-room serve`
 * neither knows nor cares whether one is running. Closing every session leaves
 * the server, the room and its history untouched.
 */
export type Multiplexer = "tmux" | "screen";

export interface MultiplexerDriver {
  name: Multiplexer;
  /** True when this driver can host several agents as panes in one window. */
  supportsPanes: boolean;
  start: (session: string, cwd: string, command: string[]) => string[];
  list: () => string[];
  parseList: (stdout: string) => string[];
  attach: (session: string) => string;
  kill: (session: string) => string[];
}

const DRIVERS: Record<Multiplexer, MultiplexerDriver> = {
  tmux: {
    name: "tmux",
    supportsPanes: true,
    start: (session, cwd, command) => [
      "new-session", "-d", "-s", session, "-c", cwd, ...command,
    ],
    list: () => ["list-sessions", "-F", "#{session_name}"],
    parseList: (stdout) => stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    attach: (session) => `tmux attach -t ${session}`,
    // Scoped to one session on purpose. `kill-server` would take down every
    // room's workspace, and anything else the human happens to be running.
    kill: (session) => ["kill-session", "-t", session],
  },
  screen: {
    name: "screen",
    // screen can split, but not reliably from a script, so it only ever hosts
    // one agent per session.
    supportsPanes: false,
    start: (session, _cwd, command) => ["-dmS", session, ...command],
    list: () => ["-ls"],
    parseList: (stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim().match(/^\d+\.(\S+)/)?.[1])
        .filter((name): name is string => Boolean(name)),
    attach: (session) => `screen -r ${session}`,
    kill: (session) => ["-S", session, "-X", "quit"],
  },
};

export const DRIVERS_FOR_TEST = DRIVERS;

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

export function detectMultiplexer(preferred?: Multiplexer): MultiplexerDriver | null {
  const order: Multiplexer[] = preferred ? [preferred] : ["tmux", "screen"];
  for (const name of order) if (onPath(name)) return DRIVERS[name];
  return null;
}

export const INSTALL_HINT =
  "Install tmux for the pane workspace: `brew install tmux` on macOS, `sudo apt install tmux` on Ubuntu.";

/**
 * tmux rejects "." and ":" in session names, so the readable part is a slug.
 * Slugging alone is lossy and collides badly: "refactor:auth", "refactor auth"
 * and "refactor-auth" all slug to the same string, which would drop three
 * different rooms into one workspace. A digest of the exact identity is
 * appended so distinct rooms always get distinct sessions, while the same room
 * always resolves to the same name — reattach depends on that determinism.
 */
const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 10);
}

/** One workspace session per room. */
export function workspaceName(room: string): string {
  return `airoom-${slug(room)}-${digest("workspace", room)}`;
}

/**
 * Per-agent session, used when panes are unavailable. The digest covers the
 * kind as well as room and agent, so a per-agent session can never land on the
 * same name as some other room's workspace.
 */
export function sessionName(room: string, agent: string): string {
  return `airoom-${slug(room)}-${slug(agent)}-${digest("agent", room, agent)}`;
}

export function liveSessions(driver: MultiplexerDriver): string[] {
  // Both tools exit non-zero with nothing to list; that is not an error.
  const result = spawnSync(driver.name, driver.list(), { encoding: "utf8" });
  return driver.parseList(`${result.stdout ?? ""}`);
}

export function sessionExists(driver: MultiplexerDriver, session: string): boolean {
  return liveSessions(driver).includes(session);
}

function run(
  bin: string,
  argv: string[],
  cwd?: string
): { ok: boolean; out: string; error: string } {
  const result = spawnSync(bin, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}`.trim(),
    error: `${result.stderr ?? ""}`.trim() || `exit ${result.status}`,
  };
}

export interface StartedSession {
  session: string;
  attachWith: string;
  multiplexer: Multiplexer;
}

export function startSession(
  driver: MultiplexerDriver,
  session: string,
  cwd: string,
  command: string[]
): StartedSession {
  const { ok, error } = run(driver.name, driver.start(session, cwd, command), cwd);
  if (!ok) throw new Error(`${driver.name} failed to start "${session}": ${error}`);
  return { session, attachWith: driver.attach(session), multiplexer: driver.name };
}

/* ------------------------------------------------------------------ panes */

export interface PaneSpec {
  /** Pane title, normally the agent name. */
  title: string;
  command: string[];
}

export interface WorkspaceResult {
  session: string;
  attachWith: string;
  created: boolean;
  panes: string[];
  /** Panes skipped because that agent already had one in a live session. */
  skipped: string[];
}

/**
 * Pane identity lives in a tmux user option, not in `pane_title`. Agents set
 * their own title through escape sequences — Codex rewrites it to things like
 * "[ ! ] Action Required" — so a title-based lookup reports every pane as
 * missing and reopening a room duplicates panes. User options are out of the
 * application's reach.
 */
export const PANE_TAG = "@airoom_agent";

export function workspacePanes(driver: MultiplexerDriver, session: string): string[] {
  const result = spawnSync(
    driver.name,
    ["list-panes", "-s", "-t", session, "-F", `#{${PANE_TAG}}`],
    { encoding: "utf8" }
  );
  return `${result.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Creates (or extends) one tmux session holding a pane per agent plus a monitor
 * pane. Reopening a room attaches to what is already there and only adds panes
 * for agents that are missing, so `ai-room open` is safe to run twice.
 */
export function ensureWorkspace(
  driver: MultiplexerDriver,
  session: string,
  cwd: string,
  panes: PaneSpec[]
): WorkspaceResult {
  if (!driver.supportsPanes) {
    throw new Error(`${driver.name} cannot host a pane workspace.`);
  }

  const existed = sessionExists(driver, session);
  const present = existed ? workspacePanes(driver, session) : [];
  const missing = panes.filter((pane) => !present.includes(pane.title));
  const added: string[] = [];

  for (const pane of missing) {
    // -P -F prints the id of the pane just created. Targeting the session
    // instead would tag whichever pane happens to be active, and select-layout
    // can change that — which silently put an agent's tag on another agent's
    // pane and made every reopen duplicate panes.
    const create = !sessionExists(driver, session)
      ? run(driver.name, ["new-session", "-d", "-s", session, "-c", cwd, "-P", "-F", "#{pane_id}", ...pane.command], cwd)
      : run(driver.name, ["split-window", "-t", session, "-c", cwd, "-P", "-F", "#{pane_id}", ...pane.command], cwd);

    if (!create.ok) throw new Error(`tmux failed to add pane "${pane.title}": ${create.error}`);
    const paneId = create.out.split("\n").pop()?.trim();
    if (!paneId) throw new Error(`tmux did not report a pane id for "${pane.title}"`);

    run(driver.name, ["set-option", "-p", "-t", paneId, PANE_TAG, pane.title], cwd);
    run(driver.name, ["set-option", "-p", "-t", paneId, "pane-border-format", ` ${pane.title} `], cwd);
    run(driver.name, ["select-layout", "-t", session, "tiled"], cwd);
    added.push(pane.title);
  }

  if (added.length) {
    run(driver.name, ["set-option", "-t", session, "pane-border-status", "top"], cwd);
    run(driver.name, ["set-option", "-t", session, "mouse", "on"], cwd);
  }

  return {
    session,
    attachWith: driver.attach(session),
    created: !existed,
    panes: added,
    skipped: panes.filter((p) => present.includes(p.title)).map((p) => p.title),
  };
}

/** Kills exactly one workspace. The room in SQLite is a separate entity. */
export function killWorkspace(driver: MultiplexerDriver, session: string): boolean {
  if (!sessionExists(driver, session)) return false;
  return run(driver.name, driver.kill(session)).ok;
}
