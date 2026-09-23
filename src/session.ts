import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Terminal multiplexing is a FRONTEND concern: it exists so a human can talk to
 * each agent directly. It is never part of the MCP protocol, and `ai-room serve`
 * neither knows nor cares whether one is running. Closing every session leaves
 * the server, the room and its history untouched.
 */
export type Multiplexer = "tmux" | "screen";

export interface MultiplexerDriver {
  name: Multiplexer;
  /** The binary and the leading arguments every invocation carries. */
  bin: () => string;
  base: () => string[];
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
    bin: () => tmuxBin() ?? "tmux",
    base: () => tmuxBase(),
    supportsPanes: true,
    start: (session, cwd, command, env) => [
      "new-session", "-d", "-s", session, "-c", cwd, ...envArgs(env), ...command,
    ],
    list: () => ["list-sessions", "-F", "#{session_name}"],
    parseList: (stdout) => stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    attach: (session) => `tmux -L ${tmuxSocket()} attach -t ${session}`,
    // Scoped to one session on purpose. `kill-server` would take down every
    // room's workspace, and anything else the human happens to be running.
    kill: (session) => ["kill-session", "-t", session],
  },
  screen: {
    name: "screen",
    bin: () => "screen",
    base: () => [],
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

/**
 * ai-room runs its workspaces on a tmux server of its own. Key bindings in tmux
 * belong to the server, so the keys a workspace needs — detach on F12, on
 * `prefix C-d`, close the room on `prefix X` — could not be added to the
 * human's own server without changing every other tmux session they run.
 */
export function tmuxSocket(): string {
  return process.env.AI_ROOM_TMUX_SOCKET || "ai-room";
}

export function tmuxConfigPath(): string {
  return process.env.AI_ROOM_TMUX_CONF || path.join(os.homedir(), ".ai-room", "tmux.conf");
}

/**
 * The human's own config is sourced first so their prefix, colours and habits
 * carry over; only the keys and the status line a workspace needs are set
 * after it.
 */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** How tmux key bindings call back into this ai-room, whatever PATH tmux has. */
export function selfCommand(): string {
  return [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url))].map(shellQuote).join(" ");
}

/**
 * Every prefix key is bound twice, bare and with Ctrl: a human holding Ctrl
 * after `Ctrl-b` sends `C-m`, `C-t`, `C-x`, `C-z` — and tmux's own `C-z`
 * suspends the client, which looks exactly like the workspace crashing.
 */
const both = (key: string, command: string) => [`bind-key ${key} ${command}`, `bind-key C-${key.toLowerCase()} ${command}`];

export function tmuxConfig(self: string = selfCommand(), clipboard: string | null = clipboardCommand()): string {
  const copy = clipboard
    ? ["copy-mode", "copy-mode-vi"].flatMap((table) =>
        ["MouseDragEnd1Pane", "y"].map((key) => `bind-key -T ${table} ${key} send-keys -X copy-pipe-and-cancel "${clipboard}"`)
      )
    : ["set -g set-clipboard on"];
  return [
    "# Generated by ai-room and rewritten on every run. Edit ~/.tmux.conf instead.",
    "source-file -q ~/.tmux.conf",
    "source-file -q ~/.config/tmux/tmux.conf",
    "set -g pane-border-status top",
    `set -g pane-border-format " #{?${PANE_TAG},#{${PANE_TAG}},#{pane_title}} "`,
    "set -g status on",
    "set -g status-left-length 60",
    `set -g status-left "#[bold] ai-room #{?${ROOM_TAG},#{${ROOM_TAG}},#S} #[default]"`,
    "set -g status-right-length 100",
    `set -g status-right " #{prefix} m panes | #{prefix} t arquivos | #{prefix} M mouse:#{?mouse,on,off} | F12 sair | #{prefix} X fechar "`,
    // Hidden panes live in windows named "_<agent>"; the tab list leaves them out.
    `set -g window-status-format "#{?#{m:${HIDDEN_PREFIX}*,#{window_name}},,#I:#W#F}"`,
    `set -g window-status-current-format "#{?#{m:${HIDDEN_PREFIX}*,#{window_name}},,#I:#W#F}"`,
    ...both("m", `{ run-shell "${self} _pane-menu '#{session_name}'" ; source-file -F "${path.join(path.dirname(tmuxConfigPath()), "menus")}/#{session_name}.tmux" }`),
    ...both("t", `run-shell -b "${self} _files '#{session_name}' '#{window_name}'"`),
    ...both("z", "resize-pane -Z"),
    ...both("X", `confirm-before -p "Fechar a sala? Os agentes serao encerrados, o historico fica. (y/n)" kill-session`),
    ...both("d", "detach-client"),
    ...both("q", "detach-client"),
    `bind-key M { set -g mouse ; display-message "mouse: #{?mouse,on,off}" }`,
    "bind-key -n F12 detach-client",
    ...copy,
    "",
  ].join("\n");
}

let configWritten = false;

function ensureTmuxConfig(): void {
  if (configWritten) return;
  configWritten = true;
  const file = tmuxConfigPath();
  const content = tmuxConfig();
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch {
    /* tmux starts without it; the workspace only loses its extra keys */
  }
}

export function tmuxBase(): string[] {
  ensureTmuxConfig();
  const file = tmuxConfigPath();
  return ["-L", tmuxSocket(), ...(fs.existsSync(file) ? ["-f", file] : [])];
}

/** A full tmux argv for this ai-room server, for callers outside a driver. */
export function tmuxArgv(args: string[]): [string, string[]] {
  return [tmuxBin() ?? "tmux", [...tmuxBase(), ...args]];
}

/**
 * A server that is already running loaded its config when it started, so a
 * workspace created by an older ai-room would keep the old keys until tmux
 * restarted. Reloading is cheap and idempotent.
 */
export function reloadTmuxConfig(driver: MultiplexerDriver): void {
  if (driver.name !== "tmux") return;
  const file = tmuxConfigPath();
  if (fs.existsSync(file)) mux(driver, ["source-file", file]);
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
  return driver.parseList(mux(driver, driver.list()).out);
}

export function sessionExists(driver: MultiplexerDriver, session: string): boolean {
  // `=` makes tmux match the name exactly instead of as a prefix.
  if (driver.name === "tmux") return mux(driver, ["has-session", "-t", `=${session}`]).ok;
  return liveSessions(driver).includes(session);
}

export function mux(
  driver: MultiplexerDriver,
  argv: string[],
  cwd?: string
): { ok: boolean; out: string; error: string } {
  return run(driver.bin(), [...driver.base(), ...argv], cwd);
}

function run(
  bin: string,
  argv: string[],
  cwd?: string,
  input?: string
): { ok: boolean; out: string; error: string } {
  const result = spawnSync(bin, argv, {
    cwd,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
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
  const { ok, error } = mux(driver, argv, cwd);
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
  /** A pane of its own window (a tab) with this name, instead of a split. */
  window?: string;
  /** In a window that already has a pane: split beside it, taking this % of the width. */
  beside?: number;
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
/** The room a workspace belongs to, for the status line; session names carry a digest. */
export const ROOM_TAG = "@airoom_room";
/** The window a pane belongs in when it is shown. */
export const HOME_TAG = "@airoom_home";
export const HIDDEN_PREFIX = "_";

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
  return parseTaggedPanes(mux(driver, ["list-panes", "-s", "-t", session, "-F", PANE_FORMAT]).out);
}

/**
 * The pane an agent lives in, resolved without a driver and without PATH: the
 * only two things needed to reach a running TUI harness are the workspace and
 * the tag ai-room put on its pane.
 */
export function paneForAgent(session: string, agent: string): string | null {
  if (!tmuxBin()) return null;
  const result = run(...tmuxArgv(["list-panes", "-s", "-t", session, "-F", PANE_FORMAT]));
  if (!result.ok) return null;
  return parseTaggedPanes(result.out).find((pane) => pane.agent === agent)?.paneId ?? null;
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
  const window = mux(driver, ["select-window", "-t", paneId]);
  const pane = mux(driver, ["select-pane", "-t", paneId]);
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
  if (!tmuxBin()) return { ok: false, error: "tmux is not installed where this process can see it" };
  const buffer = `airoom-${Date.now().toString(36)}`;
  const [bin, load] = tmuxArgv(["load-buffer", "-b", buffer, "-"]);
  const loaded = run(bin, load, undefined, text);
  if (!loaded.ok) return { ok: false, error: `tmux load-buffer failed: ${loaded.error}` };
  const paste = run(...tmuxArgv(["paste-buffer", "-p", "-b", buffer, "-d", "-t", paneId]));
  if (!paste.ok) return { ok: false, error: `tmux paste-buffer failed: ${paste.error}` };
  const enter = run(...tmuxArgv(["send-keys", "-t", paneId, "Enter"]));
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
  if (!tmuxBin()) return false;
  const result = run(...tmuxArgv(["display-message", "-p", "-t", paneId, "#{pane_in_mode}"]));
  return result.ok && result.out === "1";
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
  const result = mux(driver, ["detach-client", "-s", session]);
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
  /** Shown in the status line; the session name carries a digest. */
  room?: string;
  /** Size of a new session, so the tiled layout is right before anyone attaches. */
  size?: { columns: number; rows: number };
}

/** The window the agents are tiled in. */
export const AGENTS_WINDOW = "agents";

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
  mux(driver, ["set-option", "-t", session, "mouse", "on"], cwd);
  if (!clipboard) {
    // Nothing local to pipe into: let tmux try the terminal's own OSC 52.
    mux(driver, ["set-option", "-t", session, "set-clipboard", "on"], cwd);
    return { mouse: true, clipboard: null };
  }
  for (const key of ["MouseDragEnd1Pane", "y"]) {
    mux(
      driver,
      ["bind-key", "-T", "copy-mode", key, "send-keys", "-X", "copy-pipe-and-cancel", clipboard],
      cwd
    );
    mux(
      driver,
      ["bind-key", "-T", "copy-mode-vi", key, "send-keys", "-X", "copy-pipe-and-cancel", clipboard],
      cwd
    );
  }
  return { mouse: true, clipboard };
}

/**
 * tmux reads an argument that ends in ";" as a command separator, which would
 * cut a batched command short. Escaping keeps the argument as it was.
 */
function literal(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
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
  if (existed) reloadTmuxConfig(driver);
  const present = existed ? workspacePanes(driver, session) : [];
  // Splits first: a window created before them would become the one they split.
  const missing = panes
    .filter((pane) => !present.includes(pane.title))
    .sort((a, b) => Number(Boolean(a.window)) - Number(Boolean(b.window)));

  // Every pane goes in one tmux invocation. One process per step made opening
  // a room cost a dozen round trips before the human saw anything. A window
  // target resolves to the pane just created, because a split makes its new
  // pane the active one and a new window has only one.
  const batch: string[][] = [];
  let created = existed;
  // Every agent pane can be hidden, and with all of them hidden the agents
  // window is gone; the next split then has nothing to split.
  const windows = new Set(existed ? mux(driver, ["list-windows", "-t", session, "-F", "#{window_name}"]).out.split("\n") : []);
  let agentsWindow = windows.has(AGENTS_WINDOW);
  for (const pane of missing) {
    const env = envArgs(pane.env).map(literal);
    const command = pane.command.map(literal);
    const window = pane.window ?? AGENTS_WINDOW;
    const target = `=${session}:${window}`;
    if (!created) {
      const size = options?.size ? ["-x", `${options.size.columns}`, "-y", `${options.size.rows}`] : [];
      batch.push(["new-session", "-d", "-s", session, "-n", window, ...size, "-c", cwd, ...env, ...command]);
      if (options?.room) batch.push(["set-option", "-t", session, ROOM_TAG, literal(options.room)]);
      created = true;
      if (!pane.window) agentsWindow = true;
    } else if (pane.window && windows.has(pane.window)) {
      // The files tab holds the browser and, beside it, the editor it opens files in.
      batch.push(["split-window", "-h", "-l", `${pane.beside ?? 50}%`, "-t", target, "-c", cwd, ...env, ...command]);
    } else if (pane.window || !agentsWindow) {
      batch.push(["new-window", "-d", "-t", `=${session}:`, "-n", window, "-c", cwd, ...env, ...command]);
      if (!pane.window) agentsWindow = true;
    } else {
      batch.push(["split-window", "-t", target, "-c", cwd, ...env, ...command]);
    }
    batch.push(["set-option", "-p", "-t", target, PANE_TAG, literal(pane.title)]);
    batch.push(["set-option", "-p", "-t", target, HOME_TAG, window]);
    if (!pane.window) batch.push(["select-layout", "-t", target, "tiled"]);
    if (pane.beside !== undefined && windows.has(window)) batch.push(["last-pane", "-t", target]);
    windows.add(window);
  }

  if (batch.length) {
    const result = mux(driver, batch.flatMap((command, i) => (i ? [";", ...command] : command)), cwd);
    if (!result.ok) throw new Error(`tmux failed to build the workspace: ${result.error}`);
  }
  // Mouse mode is opt-in: turning it on takes selection away from the
  // terminal. Applied on reattach too, so a default reaches old workspaces.
  if (options?.mouse) enableMouse(driver, session, cwd);

  const added = missing.map((pane) => pane.title);
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

/* ------------------------------------------------------- show and hide */

export interface PaneState {
  agent: string;
  paneId: string;
  window: string;
  home: string;
  hidden: boolean;
}

export function paneStates(driver: MultiplexerDriver, session: string): PaneState[] {
  if (driver.name !== "tmux") return [];
  const format = `#{pane_id} #{window_name} #{${HOME_TAG}} #{${PANE_TAG}}`;
  return mux(driver, ["list-panes", "-s", "-t", session, "-F", format])
    .out.split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts) => parts.length >= 4 && parts[3])
    .map(([paneId, window, home, ...agent]) => ({
      agent: agent.join(" "),
      paneId,
      window,
      home: home || AGENTS_WINDOW,
      hidden: window.startsWith(HIDDEN_PREFIX),
    }));
}

/**
 * Hiding a pane moves it, never stops it: the agent keeps running, keeps its
 * session and is still woken through the same pane id. A pane that is alone in
 * its window hides by renaming the window; any other is broken out into a
 * window of its own and joined back when shown.
 */
export function setPaneVisible(
  driver: MultiplexerDriver,
  session: string,
  agent: string,
  mode: "show" | "hide" | "toggle"
): { ok: boolean; hidden?: boolean; error?: string } {
  const states = paneStates(driver, session);
  const pane = states.find((state) => state.agent === agent);
  if (!pane) return { ok: false, error: `no pane "${agent}" in ${session}` };
  const hide = mode === "toggle" ? !pane.hidden : mode === "hide";
  if (hide === pane.hidden) return { ok: true, hidden: pane.hidden };

  const alone = states.filter((state) => state.window === pane.window).length === 1;
  const retile = (window: string) => ["select-layout", "-t", `=${session}:${window}`, "tiled"];
  let result;
  if (hide) {
    const name = `${HIDDEN_PREFIX}${agent}`;
    result = alone
      ? mux(driver, ["rename-window", "-t", pane.paneId, name])
      : mux(driver, ["break-pane", "-d", "-s", pane.paneId, "-n", name, ";", ...retile(pane.window)]);
  } else {
    const homeExists = states.some((state) => state.window === pane.home);
    result = homeExists
      ? mux(driver, ["join-pane", "-d", "-s", pane.paneId, "-t", `=${session}:${pane.home}`, ";", ...retile(pane.home)])
      : mux(driver, ["rename-window", "-t", pane.paneId, pane.home, ";", "select-window", "-t", pane.paneId]);
  }
  return result.ok ? { ok: true, hidden: hide } : { ok: false, error: result.error };
}

/**
 * tmux parses a menu command once more: a double quote or "#" in it would end
 * or expand the string, whatever an agent chose to be called.
 */
const tmuxQuoted = (value: string) => value.replace(/[\\"]/g, "\\$&").replace(/#/g, "##");

/**
 * `prefix t`: from anywhere, go to the files tab (showing it if it was
 * hidden); from the files tab, go back to where you were.
 */
export function toggleFilesTab(driver: MultiplexerDriver, session: string, currentWindow: string): { ok: boolean; error?: string } {
  const files = paneStates(driver, session).find((state) => state.agent === "files");
  if (!files) return { ok: false, error: "this workspace has no files tab (opened with --no-files, or no file browser installed)" };
  if (currentWindow === files.window && !files.hidden) {
    const back = mux(driver, ["last-window", "-t", session]);
    return back.ok ? back : { ok: false, error: back.error };
  }
  if (files.hidden) {
    const shown = setPaneVisible(driver, session, "files", "show");
    if (!shown.ok) return shown;
  }
  const go = mux(driver, ["select-window", "-t", files.paneId]);
  return go.ok ? { ok: true } : { ok: false, error: go.error };
}

/** One argument as tmux's own parser reads it back. */
const tmuxArg = (value: string) => `"${value.replace(/[\\"$]/g, "\\$&")}"`;

/**
 * The menu `prefix m` opens, as a tmux command the server sources itself.
 * Opening it from a separate `tmux display-menu` process left that process
 * waiting for the menu to close — forever, when the terminal went away first.
 */
export function paneMenuCommand(session: string, states: PaneState[], self = selfCommand()): string {
  const label = (state: PaneState) => {
    const name = state.agent === "monitor" ? "human (monitor)" : state.agent === "files" ? "arquivos" : state.agent;
    return `${state.hidden ? "[ ]" : "[x]"} ${name}`.replace(/#/g, "##");
  };
  const entries = states.flatMap((state, i) => [
    label(state),
    i < 9 ? `${i + 1}` : "",
    `run-shell -b "${tmuxQuoted(`${self} _pane ${shellQuote(session)} ${shellQuote(state.agent)} toggle`)}"`,
  ]);
  return ["display-menu", ...["-T", "#[align=centre] panes (mostrar/esconder) ", ...entries].map(tmuxArg)].join(" ");
}

export function paneMenuFile(session: string): string {
  return path.join(path.dirname(tmuxConfigPath()), "menus", `${session}.tmux`);
}

/** A path as Vim's command line reads it back, like its own fnameescape(). */
export function vimEscape(file: string): string {
  return file.replace(/[ \t%#|"'*?[{<!\\$`]/g, "\\$&");
}

/**
 * The files tab's editor pane opens what the browser picked. This types into
 * a pane on purpose: the human's own tool, in the files tab, never an agent
 * and never the human's console.
 */
export function openInEditorPane(
  driver: MultiplexerDriver,
  session: string,
  files: string[]
): { ok: boolean; error?: string } {
  const editor = paneStates(driver, session).find((state) => state.agent === "editor");
  if (!editor) return { ok: false, error: "no editor pane in this workspace" };
  if (editor.hidden) setPaneVisible(driver, session, "editor", "show");
  const commands = files.map((file, i) => `:${i ? "badd" : "e"} ${vimEscape(path.resolve(file))}`);
  for (const command of commands) {
    const typed = mux(driver, ["send-keys", "-t", editor.paneId, "Escape", ";", "send-keys", "-t", editor.paneId, "-l", command, ";", "send-keys", "-t", editor.paneId, "Enter"]);
    if (!typed.ok) return { ok: false, error: typed.error };
  }
  mux(driver, ["select-pane", "-t", editor.paneId]);
  return { ok: true };
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

/**
 * True only inside ai-room's own tmux server. `switch-client` cannot cross to
 * another server, so from the human's own tmux the workspace is attached
 * nested instead.
 */
export function insideWorkspaceServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const socket = env.TMUX?.split(",")[0];
  return Boolean(socket) && path.basename(socket!) === tmuxSocket();
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
  // tmux refuses to start a client while $TMUX names another server; nesting
  // is intended here, so the variable is dropped for the child only.
  const env = { ...process.env };
  if (!options.insideMultiplexer) delete env.TMUX;
  const result = spawnSync(driver.bin(), [...driver.base(), ...attachArgv(driver, session, options)], {
    stdio: "inherit",
    env,
  });
  if (result.error) return { ok: false, error: result.error.message };
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: `${driver.name} exited ${result.status}` };
}

/** Kills exactly one workspace. The room in SQLite is a separate entity. */
export function killWorkspace(driver: MultiplexerDriver, session: string): boolean {
  if (!sessionExists(driver, session)) return false;
  return mux(driver, driver.kill(session)).ok;
}
