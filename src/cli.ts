import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { openDb, defaultDbPath } from "./db/index.js";
import { VERSION } from "./version.js";
import {
  roomCharter,
  roomExists,
  roomHistory,
  compactDatabase,
  pruneAttachments,
  roomDelete,
  storageCounts,
  roomJoin,
  roomList,
  roomMessageCount,
  roomSetCharter,
  roomWho,
} from "./store.js";
import { closeRoom, editorCommand, harnessFor, invite, launchProfile, logDir, openWorkspace, planWorkspace } from "./invite.js";
import {
  INSTALL_HINT,
  attachWorkspace,
  canAttach,
  detectMultiplexer,
  insideWorkspaceServer,
  liveSessions,
  mux,
  paneMenuCommand,
  paneMenuFile,
  paneStates,
  sessionExists,
  setPaneVisible,
  toggleFilesTab,
  openInEditorPane,
  sessionName,
  workspaceName,
} from "./session.js";
import { TOOL_CATALOG } from "./catalog.js";
import { missingTools } from "./presets.js";
import { attachmentRoot, formatBytes } from "./attachments.js";
import {
  agentsToLaunch,
  holdForPlan,
  charterPatch,
  assignLead,
  classifyJoins,
  loadOpenDefaults,
  parseOpenFlags,
  reuseVerdict,
  withDefaults,
} from "./open.js";
import { hookSnippet, hookStatus } from "./hooks.js";

const DEFAULT_PORT = 49375;

function port(): number {
  const raw = process.env.AI_ROOM_PORT;
  return raw ? Number(raw) : DEFAULT_PORT;
}

async function serve(): Promise<void> {
  // Loaded here, not at the top: express and the MCP SDK are most of the
  // start-up time, and every other command runs without them.
  const { createHttpApp } = await import("./http.js");
  const db = openDb();
  const app = createHttpApp(db);
  const p = port();
  app.listen(p, "127.0.0.1", () => {
    console.log(`ai-room listening on http://127.0.0.1:${p}/mcp`);
    console.log(`db: ${defaultDbPath()}`);
  });
}

async function status(asJson = false): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port()}`;
  const report: Record<string, unknown> = {
    name: "ai-room",
    version: VERSION,
    db: defaultDbPath(),
    url: baseUrl,
    multiplexer: detectMultiplexer()?.name ?? null,
    tools: TOOL_CATALOG,
  };

  type Health = { ok?: boolean; version?: string; database?: string };
  let health: Health | null = null;
  let healthError = "";
  try {
    const response = await fetch(`${baseUrl}/health`);
    health = (await response.json()) as Health;
    if (!response.ok || !health?.ok) throw new Error(`health returned HTTP ${response.status}`);
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  }

  report.server = healthError ? "unreachable" : "reachable";
  report.database = health?.database ?? "unknown";
  if (healthError) report.error = healthError;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (healthError) process.exitCode = 1;
    return;
  }

  console.log(`db: ${report.db}`);
  console.log(`url: ${baseUrl}`);
  if (healthError) {
    console.error(`server: unreachable`);
    console.error(`error: ${healthError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`server: reachable`);
  console.log(`version: ${health?.version ?? "unknown"}`);
  console.log(`database: ${health?.database ?? "unknown"}`);
  console.log(`multiplexer: ${report.multiplexer ?? "none"}`);
  console.log(`mcp tools: ${TOOL_CATALOG.length} (ai-room tools --json)`);

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "ai-room-status", version: VERSION });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const live = await client.listTools();
    console.log(`mcp: reachable (${live.tools.length} tools)`);
  } catch (error) {
    console.error(`mcp: unavailable`);
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Every room, not the MCP tool's page of 50; `--names` prints one per line for pipes. */
function rooms(argv: string[]): void {
  const query = argv.find((arg) => !arg.startsWith("--"));
  const rows = roomList(openDb(), { query, limit: -1 });
  if (argv.includes("--names")) {
    for (const row of rows) console.log(row.name);
    return;
  }
  console.log(JSON.stringify(rows, null, 2));
}

function messages(room: string): void {
  if (!room) {
    console.error("usage: ai-room messages <room>");
    process.exit(1);
  }
  const db = openDb();
  console.log(JSON.stringify(roomHistory(db, { room, limit: 100 }), null, 2));
}

function who(room: string): void {
  if (!room) {
    console.error("usage: ai-room who <room>");
    process.exit(1);
  }
  const db = openDb();
  console.log(JSON.stringify(roomWho(db, { room }), null, 2));
}


/**
 * One command replaces the two messages a human otherwise retypes: it creates
 * the room with a charter, launches each invited agent, and hands the terminal
 * to the workspace. For interactive use `open` means the whole experience, so
 * it ends attached; `--detached` is how you ask for the old behaviour.
 */
/** Asks once, on a terminal, before two tasks are merged into one room. */
async function confirmReuse(room: string, messages: number): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Room "${room}" already holds ${messages} message(s) from another task.\n` +
        `Continuing here keeps that history, those cursors and those identities.\n` +
        `Type "reuse" to continue in this room, anything else to abort: `
    );
    return answer.trim().toLowerCase() === "reuse";
  } finally {
    rl.close();
  }
}

async function open(room: string, argv: string[]): Promise<void> {
  if (!room) {
    console.error(
      'usage: ai-room open <room> [--brief "..."] [--convention caveman|ponytail] [--tool graphify,rtk,grill-me]\n' +
        "                       [--invite codex,agy] [--role codex=reviewer] [--reuse] [--mouse] [--no-files] [--no-defaults] [--detached] [--dry-run]"
    );
    process.exit(1);
  }

  const db = openDb();
  if (!argv.includes("--no-defaults") && !argv.includes("--dry-run")) {
    const { offerSetup } = await import("./setup.js");
    await offerSetup();
  }
  const defaults = loadOpenDefaults();
  const existed = roomExists(db, room);
  let flags = withDefaults(parseOpenFlags(argv), defaults, !existed);
  // An explicit cast for a room that already has one is a replacement: the
  // agents kept keep their roles, and the new cast gets a lead.
  const replacing = existed && flags.invite.length > 0;
  if (replacing) {
    const current = roomCharter(db, room);
    const roles = new Map(flags.roles);
    for (const entry of current?.roster ?? []) {
      if (flags.invite.includes(entry.agent) && entry.role && !roles.has(entry.agent)) roles.set(entry.agent, entry.role);
    }
    flags = assignLead({ ...flags, roles, convention: flags.convention ?? current?.conventionPreset ?? undefined }, defaults.lead);
  }

  // A room is a task, not just a name: reopening one that already holds a
  // conversation with a different brief silently merges two tasks.
  const verdict = reuseVerdict({
    roomExists: roomExists(db, room),
    messages: roomExists(db, room) ? roomMessageCount(db, room) : 0,
    currentBrief: roomExists(db, room) ? roomCharter(db, room)?.brief ?? null : null,
    newBrief: flags.brief,
    reuse: flags.reuse,
  });
  if (verdict.kind === "conflict" && process.stdin.isTTY && process.stdout.isTTY) {
    if (!(await confirmReuse(room, verdict.messages))) {
      console.error("aborted. the room was not touched.");
      process.exit(2);
    }
  } else if (verdict.kind === "conflict") {
    console.error(`room "${room}" already holds ${verdict.messages} message(s) from another task.`);
    console.error(`current brief: ${verdict.currentBrief ?? "(none)"}`);
    console.error("");
    console.error("Opening it with a different brief would mix both tasks: the history, the");
    console.error("cursors and the agents' identities are shared. Choose one:");
    console.error(`  ai-room open ${room} --reuse --brief "..."   continue in this room, keeping its history`);
    console.error(`  ai-room open <another-room> --brief "..."    start the new task in its own room`);
    console.error(`  ai-room open ${room}                         just reattach, keeping the current brief`);
    process.exit(2);
  }

  roomJoin(db, { room, agent: "human", role: "host" });
  // A dry run only says what would happen; retiring agents would close panes.
  if (replacing && !flags.dryRun) {
    const { replaceCast } = await import("./cast.js");
    const left = replaceCast(db, room, flags.invite);
    if (left.length) console.log(`left the room: ${left.join(", ")}`);
  }

  // The lead hands deliverables over as files in the workspace, where every
  // harness may write; they are for the human, never for a commit.
  if ((flags.convention ?? "").split(",").includes("lead")) {
    const handoff = path.join(process.cwd(), ".ai-room");
    try {
      fs.mkdirSync(path.join(handoff, "for-human"), { recursive: true });
      if (!fs.existsSync(path.join(handoff, ".gitignore"))) fs.writeFileSync(path.join(handoff, ".gitignore"), "*\n");
    } catch {
      /* the lead can still send its deliverables as messages */
    }
  }

  let charter = roomSetCharter(db, charterPatch(room, flags));
  const held = holdForPlan(charter.roster, flags, verdict.kind === "new");
  if (held !== charter.roster) charter = roomSetCharter(db, { room, roster: held });

  console.log(`room: ${room}`);
  console.log(`brief: ${charter.brief ?? "(none)"}`);
  console.log(`convention: ${charter.conventionPreset ?? "(none)"}`);
  console.log(`tools: ${charter.tools.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`roster: ${charter.roster.map((r) => r.role ? `${r.agent} (${r.role})` : r.agent).join(", ") || "(none)"}`);

  for (const tool of missingTools(charter.tools.map((t) => t.name))) {
    console.log(`tool ${tool.name} is not installed here; agents will skip it. install: ${tool.install}`);
  }

  const agents = agentsToLaunch(flags, charter.roster);
  const profiles = Object.fromEntries(charter.roster.map((entry) => [entry.agent, launchProfile(entry)]));
  const waiting = charter.roster.filter((entry) => entry.held).map((entry) => entry.agent);
  if (waiting.length) {
    console.log(`waiting for the lead's plan: ${waiting.join(", ")} (approve it with /approve in the console)`);
  }

  console.log("");

  const tmux = detectMultiplexer("tmux");
  const useWorkspace = !flags.detached && Boolean(tmux);

  if (flags.dryRun) {
    const plan = planWorkspace(room, agents, { monitor: flags.monitor, files: flags.files, profiles });
    console.log(`mode: ${useWorkspace ? "tmux workspace" : flags.detached ? "detached" : "detached (no tmux)"}`);
    for (const pane of plan.panes) {
      console.log(`  ${pane.title}: ${pane.command.join(" ")}`);
    }
    if (plan.missing.length) console.log(`  not installed: ${plan.missing.join(", ")}`);
    if (useWorkspace) console.log(`  then attach to ${workspaceName(room)}`);
    return;
  }

  if (useWorkspace) {
    try {
      const { plan, result } = openWorkspace(room, agents, {
        monitor: flags.monitor,
        files: flags.files,
        mouse: flags.mouse,
        profiles,
        size: process.stdout.isTTY
          ? { columns: process.stdout.columns, rows: Math.max(10, process.stdout.rows - 1) }
          : undefined,
      });
      if (plan.missing.length) {
        console.error(`not on PATH, skipped: ${plan.missing.join(", ")}`);
        process.exitCode = 1;
      }
      console.log(
        result.created
          ? `created tmux workspace ${result.session} with panes: ${result.panes.join(", ")}`
          : `reused tmux workspace ${result.session}` +
              (result.panes.length ? `, added panes: ${result.panes.join(", ")}` : " (nothing to add)")
      );
      if (result.skipped.length) console.log(`already running: ${result.skipped.join(", ")}`);

      if (!sessionExists(tmux!, result.session)) {
        console.log("nothing to attach to: no agent was launched and no workspace exists.");
        return;
      }
      // A piped or non-interactive run has no terminal to hand over, so it
      // waits for the joins and reports them instead. Interactively the human
      // goes straight in: agents take tens of seconds to boot, and the monitor
      // pane shows each one arrive.
      if (!canAttach()) {
        await reportJoins(db, room, plan.agents);
        console.log(`\nattach with:  ${result.attachWith}`);
        return;
      }
      const attached = attachWorkspace(tmux!, result.session, {
        insideMultiplexer: insideWorkspaceServer(),
      });
      if (!attached.ok) {
        console.error(`attach failed: ${attached.error}`);
        console.error(`attach manually with:  ${result.attachWith}`);
        process.exitCode = 1;
      }
      return;
    } catch (error) {
      console.error(`workspace failed: ${error instanceof Error ? error.message : error}`);
      console.error("falling back to detached sessions.");
      process.exitCode = 1;
    }
  } else if (!flags.detached && !tmux) {
    console.log(`tmux not found, using detached sessions. ${INSTALL_HINT}\n`);
  }

  if (!agents.length) {
    console.log("invited: nobody");
    return;
  }

  for (const agent of agents) {
    const result = invite(room, agent, { profile: profiles[agent] });
    if (result.status === "launched") {
      console.log(
        result.mode === "headless"
          ? `launched ${agent} headless -> ${result.logPath}`
          : `launched ${agent} in session ${result.session}\n  attach with: ${result.attachWith}`
      );
    } else if (result.status === "skipped") {
      console.log(`${agent}: ${result.error}`);
    } else {
      console.error(`failed ${agent}: ${result.error}`);
      process.exitCode = 1;
    }
  }

  console.log(`\nwatch everything in one window:  ai-room console ${room}`);
}

const JOIN_GRACE_MS = Number(process.env.AI_ROOM_JOIN_GRACE_MS ?? 45_000);

/**
 * Waits for the agents `open` just launched to appear in the room, and says so.
 * A pane that starts and never joins is the failure mode this makes visible:
 * before, the workspace looked fine and the room was empty.
 */
async function reportJoins(db: ReturnType<typeof openDb>, room: string, agents: string[]): Promise<void> {
  if (!agents.length) return;
  const launched = agents.map((agent) => ({ agent, harness: harnessFor(agent) }));
  const startedAt = Date.now();
  let reports = classifyJoins(launched, new Set(), 0, JOIN_GRACE_MS);

  console.log("");
  while (Date.now() - startedAt < JOIN_GRACE_MS) {
    const joined = new Set(
      roomWho(db, { room })
        .filter((p) => p.active && p.agent !== "human")
        .map((p) => p.agent)
    );
    reports = classifyJoins(launched, joined, Date.now() - startedAt, JOIN_GRACE_MS);
    if (reports.every((r) => r.state === "joined")) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  reports = classifyJoins(
    launched,
    new Set(
      roomWho(db, { room })
        .filter((p) => p.active && p.agent !== "human")
        .map((p) => p.agent)
    ),
    Date.now() - startedAt,
    JOIN_GRACE_MS
  );

  for (const report of reports) {
    const seconds = (report.waitedMs / 1000).toFixed(0);
    if (report.state === "joined") {
      console.log(`${report.agent} (${report.harness}): joined in ${seconds}s`);
    } else {
      console.error(`${report.agent} (${report.harness}): ${report.state} after ${seconds}s`);
      if (report.detail) console.error(`  ${report.detail}`);
      process.exitCode = 1;
    }
  }
}

/** Closes only the tmux workspace. The room, its charter and history remain. */
function close(room: string): void {
  if (!room) {
    console.error("usage: ai-room close <room>");
    process.exit(1);
  }
  const closed = closeRoom(room);
  if (!closed.length) {
    console.log(`no live session for "${room}".`);
    return;
  }
  for (const { session, agent } of closed) {
    console.log(agent ? `closed ${agent} session ${session}.` : `closed workspace ${session}.`);
  }
  console.log(`the room, its charter and its history are untouched.`);
}

function parseDuration(value: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

/** Frees attachment files; history keeps saying what was sent. */
function attachments(argv: string[]): void {
  const [action, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  const olderThan = parseDuration(flag("--older-than") ?? "30d");
  if (action !== "prune" || olderThan === null) {
    console.error("usage: ai-room attachments prune [--older-than 30d] [--room <room>]");
    process.exit(1);
  }
  const pruned = pruneAttachments(openDb(), { olderThanMs: olderThan, room: flag("--room") });
  console.log(`pruned ${pruned} attachment(s). the messages keep their metadata.`);
}

/**
 * Deletes rooms for good. On a terminal it lists them and asks once: the room's
 * name for one, "delete N" for several, because nothing can be recovered
 * afterwards. `--yes` is for scripts.
 */
async function deleteRooms(argv: string[]): Promise<void> {
  const names = [...new Set(argv.filter((arg) => !arg.startsWith("--")))];
  if (!names.length) {
    console.error("usage: ai-room delete <room> [<room>...] [--yes]");
    process.exit(1);
  }
  const db = openDb();
  const missing = names.filter((room) => !roomExists(db, room));
  if (missing.length) {
    console.error(`no room: ${missing.join(", ")}. nothing was deleted.`);
    process.exit(1);
  }
  if (!argv.includes("--yes")) {
    if (!process.stdin.isTTY) {
      console.error("refusing to delete without a terminal; pass --yes.");
      process.exit(2);
    }
    for (const room of names) console.log(`  ${room}  ${roomMessageCount(db, room)} message(s)`);
    const expected = names.length === 1 ? names[0] : `delete ${names.length}`;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Delete ${names.length === 1 ? "this room" : `these ${names.length} rooms`}, with charter and attachments? This cannot be undone.\n` +
        `Type "${expected}" to confirm: `
    );
    rl.close();
    if (answer.trim() !== expected) {
      console.error("aborted. nothing was deleted.");
      process.exit(2);
    }
  }
  for (const room of names) {
    for (const { session } of closeRoom(room)) console.log(`closed ${session}.`);
    const deleted = roomDelete(db, room)!;
    console.log(`deleted room "${room}": ${deleted.messages} message(s), ${deleted.attachments} attachment(s).`);
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function directorySize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        bytes += fileSize(full);
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function storageReport() {
  const db = openDb();
  const file = defaultDbPath();
  const database = {
    path: file,
    bytes: fileSize(file),
    walBytes: fileSize(`${file}-wal`),
    shmBytes: fileSize(`${file}-shm`),
  };
  const attachments = { path: attachmentRoot(), ...directorySize(attachmentRoot()) };
  const logs = { path: logDir(), ...directorySize(logDir()) };
  return { database, attachments, logs, counts: storageCounts(db) };
}

function storage(asJson: boolean): void {
  const report = storageReport();
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const { database, attachments, logs, counts } = report;
  const total = database.bytes + database.walBytes + database.shmBytes + attachments.bytes + logs.bytes;
  const pad = (label: string) => label.padEnd(12);
  console.log(`${pad("database")}${formatBytes(database.bytes)}  (+ wal ${formatBytes(database.walBytes)}, shm ${formatBytes(database.shmBytes)})  ${database.path}`);
  console.log(`${pad("attachments")}${formatBytes(attachments.bytes)} in ${attachments.files} file(s)  ${attachments.path}`);
  console.log(`${pad("logs")}${formatBytes(logs.bytes)} in ${logs.files} file(s)  ${logs.path}`);
  console.log(`${pad("total")}${formatBytes(total)}`);
  console.log("");
  console.log(
    `${counts.rooms} room(s), ${counts.messages} message(s), ${counts.attachments} attachment(s)` +
      (counts.purgedAttachments ? `, ${counts.purgedAttachments} pruned` : "")
  );
  if (counts.largestRooms.length) {
    console.log("\nlargest rooms:");
    for (const room of counts.largestRooms) {
      const last = room.lastActivityAt ? new Date(room.lastActivityAt).toISOString().slice(0, 10) : "never";
      const files = room.attachments ? `, ${room.attachments} attachment(s) ${formatBytes(room.attachmentBytes)}` : "";
      console.log(`  ${room.room}  ${room.messages} message(s)${files}  last ${last}`);
    }
  }
  console.log("\nfree space: ai-room delete <room> · ai-room attachments prune --older-than 30d · ai-room compact");
}

function compact(): void {
  const file = defaultDbPath();
  const before = fileSize(file) + fileSize(`${file}-wal`);
  compactDatabase(openDb());
  const after = fileSize(file) + fileSize(`${file}-wal`);
  console.log(`database ${formatBytes(before)} -> ${formatBytes(after)}`);
}

const PANE_MODES = new Set(["show", "hide", "toggle"]);

/**
 * Shows or hides one pane of a workspace without stopping what runs in it.
 * `_pane` takes the tmux session straight from a key binding; `pane` is the
 * same thing addressed by room, for a human at a shell.
 */
function pane(session: string, agent: string, mode = "toggle"): void {
  const tmux = detectMultiplexer("tmux");
  if (!session || !agent || !PANE_MODES.has(mode) || !tmux) {
    console.error("usage: ai-room pane <room> <agent|monitor|files> [show|hide|toggle]");
    process.exit(1);
  }
  const result = setPaneVisible(tmux, session, agent, mode as "show" | "hide" | "toggle");
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
  } else if (process.stdout.isTTY) {
    console.log(`${agent}: ${result.hidden ? "hidden" : "shown"}`);
  }
}

function filesTab(session: string, currentWindow: string): void {
  const tmux = detectMultiplexer("tmux");
  if (!tmux || !session) process.exit(1);
  const result = toggleFilesTab(tmux, session, currentWindow ?? "");
  if (!result.ok) mux(tmux, ["display-message", "-t", session, result.error ?? "files tab unavailable"]);
}

/** Writes the menu for tmux to source; the key binding then shows it itself. */
function paneMenu(session: string): void {
  const tmux = detectMultiplexer("tmux");
  if (!tmux || !session) process.exit(1);
  const states = paneStates(tmux, session);
  const file = paneMenuFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, states.length ? `${paneMenuCommand(session, states)}\n` : `display-message "no panes"\n`);
}

function tools(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ name: "ai-room", version: VERSION, count: TOOL_CATALOG.length, tools: TOOL_CATALOG }, null, 2));
    return;
  }
  console.log(`ai-room ${VERSION} — ${TOOL_CATALOG.length} MCP tools`);
  for (const tool of TOOL_CATALOG) {
    console.log(`  ${tool.name}${tool.mutates ? "" : "  (read-only)"}\n    ${tool.summary}`);
  }
}

/**
 * Where the unread hook goes and whether it is there. An agent that is working
 * has no room_wait parked, so this hook is the only thing that tells it a
 * message arrived before it acts on stale context.
 */
function hooks(asJson: boolean): void {
  const status = hookStatus();
  if (asJson) {
    console.log(JSON.stringify({ name: "ai-room", version: VERSION, hooks: status }, null, 2));
    return;
  }
  for (const entry of status) {
    console.log(`${entry.harness}: ${entry.installed ? "installed" : "not installed"}`);
    console.log(`  config: ${entry.configPath}`);
    console.log(`  event:  ${entry.event}`);
    if (entry.note) console.log(`  note:   ${entry.note}`);
    if (!entry.installed) {
      console.log(hookSnippet(entry.harness).split("\n").map((line) => `  ${line}`).join("\n"));
    }
  }
}

function agents(room: string): void {
  if (!room) {
    console.error("usage: ai-room agents <room>");
    process.exit(1);
  }
  const driver = detectMultiplexer();
  if (!driver) {
    console.error(`No tmux or screen on PATH. ${INSTALL_HINT}`);
    process.exit(1);
  }
  const prefix = sessionName(room, "").slice(0, -1);
  const live = liveSessions(driver).filter((s) => s.startsWith(prefix));
  if (!live.length) {
    console.log(`no live agent sessions for "${room}".`);
    return;
  }
  for (const session of live) {
    console.log(`${session}\n  attach with: ${driver.attach(session)}`);
  }
}

const [, , cmd, arg] = process.argv;

switch (cmd) {
  case "serve":
    await serve();
    break;
  case "status":
    await status(process.argv.includes("--json"));
    break;
  case "rooms":
    rooms(process.argv.slice(3));
    break;
  case "messages":
    messages(arg);
    break;
  case "who":
    who(arg);
    break;
  case "open":
    await open(arg, process.argv.slice(4));
    break;
  case "console":
    if (!arg) {
      console.error("usage: ai-room console <room>");
      process.exit(1);
    }
    await (await import("./console.js")).runConsole(arg, { baseUrl: `http://127.0.0.1:${port()}` });
    break;
  case "agents":
    agents(arg);
    break;
  case "close":
    close(arg);
    break;
  case "storage":
    storage(process.argv.includes("--json"));
    break;
  case "compact":
    compact();
    break;
  case "delete":
    await deleteRooms(process.argv.slice(3));
    break;
  case "pane":
    pane(arg ? workspaceName(arg) : "", process.argv[4], process.argv[5]);
    break;
  case "_pane":
    pane(arg, process.argv[4], process.argv[5]);
    break;
  case "_edit": {
    // $EDITOR of the files tab's browser: into the editor pane, or a plain
    // editor right here when there is none.
    const files = process.argv.slice(4);
    const tmux = detectMultiplexer("tmux");
    const sent = tmux && arg ? openInEditorPane(tmux, arg, files, editorCommand()) : { ok: false };
    if (!sent.ok) {
      const { spawnSync } = await import("node:child_process");
      process.exitCode = spawnSync(process.env.AI_ROOM_FALLBACK_EDITOR || "vim", files, { stdio: "inherit" }).status ?? 1;
    }
    break;
  }
  case "_files":
    filesTab(arg, process.argv[4]);
    break;
  case "attach":
    await open(arg, []);
    break;
  case "_pane-menu":
    paneMenu(arg);
    break;
  case "doctor": {
    const { renderChecks, runChecks } = await import("./doctor.js");
    const checks = await runChecks(port());
    console.log(process.argv.includes("--json") ? JSON.stringify(checks, null, 2) : renderChecks(checks));
    if (checks.some((check) => check.level === "fail")) process.exitCode = 1;
    break;
  }
  case "remove":
  case "add": {
    const agent = process.argv[4];
    if (!arg || !agent) {
      console.error(`usage: ai-room ${cmd} <room> <agent>${cmd === "add" ? " [--role <role>]" : ""}`);
      process.exit(1);
    }
    const { addAgent, removeAgent } = await import("./cast.js");
    const db = openDb();
    if (cmd === "remove") {
      const result = removeAgent(db, arg, agent);
      (result.ok ? console.log : console.error)(result.detail);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    const roleAt = process.argv.indexOf("--role");
    const role = roleAt > 0 ? process.argv[roleAt + 1] : undefined;
    let result = addAgent(db, arg, agent, role, { confirmed: process.argv.includes("--yes") });
    if (!result.ok && result.confirm && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`${agent} is already in "${arg}" (to replace it, run 'ai-room remove' first). Open another instance, ${result.confirm}? [y/N] `);
      rl.close();
      if (/^(y|yes|s|sim)$/i.test(answer.trim())) result = addAgent(db, arg, agent, role, { confirmed: true });
      else {
        console.error("aborted. nothing was added.");
        process.exit(2);
      }
    }
    (result.ok ? console.log : console.error)(result.ok ? result.detail : `${result.detail}${result.confirm ? " (pass --yes)" : ""}`);
    if (!result.ok) process.exitCode = 1;
    break;
  }
  case "service":
    await (await import("./service.js")).service(arg, port());
    break;
  case "attachments":
    attachments(process.argv.slice(3));
    break;
  case "hooks":
    hooks(process.argv.includes("--json"));
    break;
  case "setup": {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    break;
  }
  case "tools":
    tools(process.argv.includes("--json"));
    break;
  default:
    // `ai-room <room> --brief ... --invite ...` is `open` with the word left out.
    // Only with flags after it: a mistyped command alone still gets the usage.
    if (cmd && !cmd.startsWith("-") && arg?.startsWith("--")) {
      await open(cmd, process.argv.slice(3));
      break;
    }
    console.error(
      "usage: ai-room <serve|setup|doctor [--json]|service <install|status|start|stop|restart|logs|uninstall>|status [--json]|tools [--json]|hooks [--json]|" +
        "console <room>|open <room> [flags]|attach <room>|add <room> <agent> [--role r] [--yes]|remove <room> <agent>|close <room>|delete <room>... [--yes]|agents <room>|pane <room> <agent> [show|hide|toggle]|" +
        "rooms [query] [--names]|messages <room>|who <room>|storage [--json]|compact|attachments prune [--older-than 30d]>"
    );
    process.exit(1);
}
