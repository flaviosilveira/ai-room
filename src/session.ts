import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Agents run inside a detached terminal multiplexer session rather than with
 * their output redirected to a file. That costs one dependency and buys the
 * thing a log file can never provide: a real TTY. The agent's own approval
 * prompt exists and works, so a human can attach on demand and answer it —
 * without deciding at launch time which agent will end up needing attention.
 */
export type Multiplexer = "tmux" | "screen";

export interface MultiplexerDriver {
  name: Multiplexer;
  /** argv that starts `command` detached under `session`. */
  start: (session: string, cwd: string, command: string[]) => string[];
  /** argv that lists live session names, one per line, on stdout. */
  list: () => string[];
  /** Parse that listing into session names. */
  parseList: (stdout: string) => string[];
  /** Shell command a human runs to attach. Printed, never executed for them. */
  attach: (session: string) => string;
  kill: (session: string) => string[];
}

const DRIVERS: Record<Multiplexer, MultiplexerDriver> = {
  tmux: {
    name: "tmux",
    start: (session, cwd, command) => [
      "new-session", "-d", "-s", session, "-c", cwd, ...command,
    ],
    list: () => ["list-sessions", "-F", "#{session_name}"],
    parseList: (stdout) => stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    attach: (session) => `tmux attach -t ${session}`,
    kill: (session) => ["kill-session", "-t", session],
  },
  screen: {
    name: "screen",
    // -dmS starts detached; screen has no -c, so cwd comes from the spawn call.
    start: (session, _cwd, command) => ["-dmS", session, ...command],
    list: () => ["-ls"],
    // `screen -ls` prints lines like "\t12345.name\t(Detached)".
    parseList: (stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim().match(/^\d+\.(\S+)/)?.[1])
        .filter((name): name is string => Boolean(name)),
    attach: (session) => `screen -r ${session}`,
    kill: (session) => ["-S", session, "-X", "quit"],
  },
};

/** Exposed so the argv and parsing rules can be tested without tmux or screen installed. */
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

/** tmux is preferred; screen is the fallback because macOS ships it. */
export function detectMultiplexer(preferred?: Multiplexer): MultiplexerDriver | null {
  const order: Multiplexer[] = preferred ? [preferred] : ["tmux", "screen"];
  for (const name of order) {
    if (onPath(name)) return DRIVERS[name];
  }
  return null;
}

export const INSTALL_HINT =
  "Install tmux: `brew install tmux` on macOS, `sudo apt install tmux` on Ubuntu.";

/**
 * tmux rejects "." and ":" in session names and screen is happiest with a plain
 * token, so everything outside a safe set collapses to "-".
 */
export function sessionName(room: string, agent: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-");
  return `airoom-${safe(room)}-${safe(agent)}`;
}

export function liveSessions(driver: MultiplexerDriver): string[] {
  const result = spawnSync(driver.name, driver.list(), { encoding: "utf8" });
  // Both tools exit non-zero when there is nothing to list; that is not an error.
  return driver.parseList(`${result.stdout ?? ""}`);
}

export function sessionExists(driver: MultiplexerDriver, session: string): boolean {
  return liveSessions(driver).includes(session);
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
  const result = spawnSync(driver.name, driver.start(session, cwd, command), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim() || `exit ${result.status}`;
    throw new Error(`${driver.name} failed to start "${session}": ${detail}`);
  }
  return {
    session,
    attachWith: driver.attach(session),
    multiplexer: driver.name,
  };
}
