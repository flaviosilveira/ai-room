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
  start: (session: string, cwd: string, command: string[], env?: Record<string, string>) => string[];
  list: () => string[];
  parseList: (stdout: string) => string[];
  attach: (session: string) => string;
  kill: (session: string) => string[];
}

const DRIVERS: Record<Multiplexer, MultiplexerDriver> = {
  tmux: {
    name: "tmux",
    supportsPanes: true,
    start: (session, cwd, command, env) => [
      "new-session", "-d", "-s", session, "-c", cwd, ...envArgs(env), ...command,
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
    // screen has no per-session env flag; the launcher exports the variables
    // into the command itself instead.
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

/**
 * Where tmux actually is.
 *
 * The server runs from a LaunchAgent whose PATH is the system default, and
 * Homebrew's tmux is not on it — so a server that had to reach a pane found no
 * tmux at all, and the wake failed with the room none the wiser. PATH first,
 * then the places tmux is normally installed.
 */
const TMUX_FALLBACKS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

export function tmuxBin(): string | null {
  const override = process.env.AI_ROOM_TMUX;
  if (override) return fs.existsSync(override) ? override : null;
  if (onPath("tmux")) return "tmux";
  return TMUX_FALLBACKS.find((candidate) => fs.existsSync(candidate)) ?? null;
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
  command: string[],
  env?: Record<string, string>
): StartedSession {
  const argv =
    driver.supportsPanes || !env
      ? driver.start(session, cwd, command, env)
      : driver.start(session, cwd, ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...command]);
  const { ok, error } = run(driver.name, argv, cwd);
  if (!ok) throw new Error(`${driver.name} failed to start "${session}": ${error}`);
  return { session, attachWith: driver.attach(session), multiplexer: driver.name };
}

/* ------------------------------------------------------------------ panes */

export interface PaneSpec {
  /** Pane title, normally the agent name. */
  title: string;
  command: string[];
  /** Exported into the pane's process, and therefore into its hooks. */
  env?: Record<string, string>;
}

/** tmux takes one `-e KEY=value` per variable, for new-session and split-window alike. */
function envArgs(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
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
  return listTaggedPanes(driver, session).map((pane) => pane.agent);
}

/**
 * The pane id first, then the tag: a pane id never contains a space, so the
 * split is unambiguous whatever the tag holds. A tab separator looked tidier
 * and came back mangled through some environments, which made every pane
 * invisible and every wake fail with "no pane".
 */
const PANE_FORMAT = `#{pane_id} #{${PANE_TAG}}`;

export function parseTaggedPanes(stdout: string): TaggedPane[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      if (space === -1) return null;
      const paneId = line.slice(0, space);
      const agent = line.slice(space + 1).trim();
      return agent ? { agent, paneId } : null;
    })
    .filter((pane): pane is TaggedPane => pane !== null);
}

export interface TaggedPane {
  agent: string;
  paneId: string;
}

/** Every pane in the workspace that ai-room tagged, with its stable pane id. */
export function listTaggedPanes(driver: MultiplexerDriver, session: string): TaggedPane[] {
  if (driver.name !== "tmux") return [];
  return parseTaggedPanes(
    `${spawnSync(driver.name, ["list-panes", "-s", "-t", session, "-F", PANE_FORMAT], {
      encoding: "utf8",
    }).stdout ?? ""}`
  );
}

/**
 * The pane an agent lives in, resolved without a driver and without PATH: the
 * only two things needed to reach a running TUI harness are the workspace and
 * the tag ai-room put on its pane.
 */
export function paneForAgent(session: string, agent: string): string | null {
  const tmux = tmuxBin();
  if (!tmux) return null;
  const result = spawnSync(tmux, ["list-panes", "-s", "-t", session, "-F", PANE_FORMAT], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return parseTaggedPanes(`${result.stdout ?? ""}`).find((pane) => pane.agent === agent)?.paneId ?? null;
}

export function agentPane(
  driver: MultiplexerDriver,
  session: string,
  agent: string
): string | null {
  return listTaggedPanes(driver, session).find((pane) => pane.agent === agent)?.paneId ?? null;
}

/**
 * Brings an agent's pane to the front. Identity is the pane id behind the
 * ai-room tag, never the pane title — agents rewrite their own titles, and a
 * title lookup focuses whatever pane happens to have been renamed last.
 */
export function focusPane(
  driver: MultiplexerDriver,
  paneId: string
): { ok: boolean; error?: string } {
  const window = run(driver.name, ["select-window", "-t", paneId]);
  const pane = run(driver.name, ["select-pane", "-t", paneId]);
  if (pane.ok || window.ok) return { ok: true };
  return { ok: false, error: pane.error || window.error };
}

/**
 * Puts text into a pane as if it had been pasted there, then presses Enter.
 *
 * `load-buffer -` takes the payload on stdin, so nothing goes through a shell
 * and no quoting can change what arrives. `paste-buffer -p` wraps it in the
 * terminal's paste markers, so the harness on the other side sees one block
 * instead of a line at a time.
 */
export function pasteIntoPane(paneId: string, text: string): { ok: boolean; error?: string } {
  const tmux = tmuxBin();
  if (!tmux) return { ok: false, error: "tmux is not installed where this process can see it" };
  const buffer = `airoom-${Date.now().toString(36)}`;
  const load = spawnSync(tmux, ["load-buffer", "-b", buffer, "-"], {
    input: text,
    encoding: "utf8",
  });
  if (load.status !== 0) {
    return { ok: false, error: `tmux load-buffer failed: ${`${load.stderr ?? ""}`.trim()}` };
  }
  const paste = run(tmux, ["paste-buffer", "-p", "-b", buffer, "-d", "-t", paneId]);
  if (!paste.ok) return { ok: false, error: `tmux paste-buffer failed: ${paste.error}` };
  const enter = run(tmux, ["send-keys", "-t", paneId, "Enter"]);
  return enter.ok ? { ok: true } : { ok: false, error: `tmux send-keys failed: ${enter.error}` };
}

/**
 * How long ago anything happened in this pane. A wake is skipped while the pane
 * is busy, so a notice never lands in the middle of what a human is typing.
 */
/**
 * True while a human is reading this pane: copy-mode or scrollback. tmux tracks
 * activity per window, not per pane, and the monitor pane keeps its window busy
 * all the time, so elapsed time tells us nothing about a specific pane.
 */
export function paneBusy(paneId: string): boolean {
  const tmux = tmuxBin();
  if (!tmux) return false;
  const result = spawnSync(tmux, ["display-message", "-p", "-t", paneId, "#{pane_in_mode}"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  return `${result.stdout ?? ""}`.trim() === "1";
}

/** Detaches every client of one workspace. Panes, agents and room keep running. */
export function detachWorkspace(
  driver: MultiplexerDriver,
  session: string
): { ok: boolean; error?: string } {
  if (driver.name !== "tmux") {
    return { ok: false, error: `${driver.name} cannot detach a workspace from a script.` };
  }
  if (!sessionExists(driver, session)) return { ok: false, error: `no session "${session}"` };
  const result = run(driver.name, ["detach-client", "-s", session]);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Creates (or extends) one tmux session holding a pane per agent plus a monitor
 * pane. Reopening a room attaches to what is already there and only adds panes
 * for agents that are missing, so `ai-room open` is safe to run twice.
 */
export interface WorkspaceOptions {
  /** Hand the mouse to tmux, and wire copying so it still reaches the clipboard. */
  mouse?: boolean;
}

/**
 * The command tmux pipes a copy-mode selection into. Going through the local
 * clipboard tool avoids depending on the terminal emulator supporting OSC 52,
 * which is what usually makes "copy from tmux" silently do nothing.
 */
export function clipboardCommand(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  has: (bin: string) => boolean = onPath
): string | null {
  if (platform === "darwin") return has("pbcopy") ? "pbcopy" : null;
  if (env.WAYLAND_DISPLAY && has("wl-copy")) return "wl-copy";
  if (has("xclip")) return "xclip -selection clipboard -in";
  if (has("xsel")) return "xsel --clipboard --input";
  return null;
}

/**
 * Mouse on, plus the bindings that make a selection reach the system clipboard:
 * drag to copy, and `y` in copy-mode. These live in the running tmux server for
 * as long as it lasts — no file of the human's is touched.
 */
export function enableMouse(
  driver: MultiplexerDriver,
  session: string,
  cwd: string,
  clipboard: string | null = clipboardCommand()
): { mouse: boolean; clipboard: string | null } {
  run(driver.name, ["set-option", "-t", session, "mouse", "on"], cwd);
  if (!clipboard) {
    // Nothing local to pipe into: let tmux try the terminal's own OSC 52.
    run(driver.name, ["set-option", "-t", session, "set-clipboard", "on"], cwd);
    return { mouse: true, clipboard: null };
  }
  for (const key of ["MouseDragEnd1Pane", "y"]) {
    run(
      driver.name,
      ["bind-key", "-T", "copy-mode", key, "send-keys", "-X", "copy-pipe-and-cancel", clipboard],
      cwd
    );
    run(
      driver.name,
      ["bind-key", "-T", "copy-mode-vi", key, "send-keys", "-X", "copy-pipe-and-cancel", clipboard],
      cwd
    );
  }
  return { mouse: true, clipboard };
}

export function ensureWorkspace(
  driver: MultiplexerDriver,
  session: string,
  cwd: string,
  panes: PaneSpec[],
  options?: WorkspaceOptions
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
    const env = envArgs(pane.env);
    const create = !sessionExists(driver, session)
      ? run(driver.name, ["new-session", "-d", "-s", session, "-c", cwd, ...env, "-P", "-F", "#{pane_id}", ...pane.command], cwd)
      : run(driver.name, ["split-window", "-t", session, "-c", cwd, ...env, "-P", "-F", "#{pane_id}", ...pane.command], cwd);

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
    // Mouse mode is opt-in: turning it on takes selection away from the
    // terminal, and copying with the mouse stops working the way it does in
    // every other window.
    if (options?.mouse) enableMouse(driver, session, cwd);
  }

  return {
    session,
    attachWith: driver.attach(session),
    // A pane list with nothing missing starts no session, so `!existed` alone
    // reported a workspace that was never created and left `open` trying to
    // attach to a name tmux does not know.
    created: !existed && added.length > 0,
    panes: added,
    skipped: panes.filter((p) => present.includes(p.title)).map((p) => p.title),
  };
}

/* ----------------------------------------------------------------- attach */

/**
 * Handing the terminal over is the whole point of `open` for interactive use,
 * so the argv differs by where the human already is: attaching from inside a
 * multiplexer nests one session in another, which tmux refuses outright.
 */
export function attachArgv(
  driver: MultiplexerDriver,
  session: string,
  options: { insideMultiplexer?: boolean } = {}
): string[] {
  if (driver.name === "tmux") {
    return options.insideMultiplexer
      ? ["switch-client", "-t", session]
      : ["attach-session", "-t", session];
  }
  return ["-r", session];
}

export function insideMultiplexer(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.STY);
}

/** Attaching needs a terminal on both ends; a piped or CI run has neither. */
export function canAttach(
  stream: { isTTY?: boolean } = process.stdout,
  input: { isTTY?: boolean } = process.stdin
): boolean {
  return Boolean(stream.isTTY && input.isTTY);
}

/**
 * Blocks until the human detaches. This is the last thing `open` does, so the
 * exit status of the multiplexer becomes the exit status of the command.
 */
export function attachWorkspace(
  driver: MultiplexerDriver,
  session: string,
  options: { insideMultiplexer?: boolean } = {}
): { ok: boolean; error?: string } {
  const result = spawnSync(driver.name, attachArgv(driver, session, options), {
    stdio: "inherit",
  });
  if (result.error) return { ok: false, error: result.error.message };
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: `${driver.name} exited ${result.status}` };
}

/** Kills exactly one workspace. The room in SQLite is a separate entity. */
export function killWorkspace(driver: MultiplexerDriver, session: string): boolean {
  if (!sessionExists(driver, session)) return false;
  return run(driver.name, driver.kill(session)).ok;
}
