import readline from "node:readline/promises";
import { openDb, defaultDbPath } from "./db/index.js";
import { VERSION } from "./version.js";
import { createHttpApp } from "./http.js";
import {
  roomCharter,
  roomExists,
  roomHistory,
  roomJoin,
  roomList,
  roomMessageCount,
  roomSetCharter,
  roomWho,
} from "./store.js";
import { closeRoom, harnessFor, invite, openWorkspace, planWorkspace } from "./invite.js";
import { runConsole } from "./console.js";
import {
  INSTALL_HINT,
  attachWorkspace,
  canAttach,
  detectMultiplexer,
  insideMultiplexer,
  liveSessions,
  sessionExists,
  sessionName,
  workspaceName,
} from "./session.js";
import { TOOL_CATALOG } from "./catalog.js";
import {
  agentsToLaunch,
  charterPatch,
  classifyJoins,
  parseOpenFlags,
  reuseVerdict,
} from "./open.js";
import { hookSnippet, hookStatus } from "./hooks.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_PORT = 49375;

function port(): number {
  const raw = process.env.AI_ROOM_PORT;
  return raw ? Number(raw) : DEFAULT_PORT;
}

function serve(): void {
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

function rooms(query?: string): void {
  const db = openDb();
  const rows = roomList(db, { query });
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
      'usage: ai-room open <room> [--brief "..."] [--convention caveman] [--tool graphify]\n' +
        "                       [--invite codex,agy] [--role codex=reviewer] [--reuse] [--detached] [--dry-run]"
    );
    process.exit(1);
  }

  const flags = parseOpenFlags(argv);
  const db = openDb();

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

  const charter = roomSetCharter(db, charterPatch(room, flags));

  console.log(`room: ${room}`);
  console.log(`brief: ${charter.brief ?? "(none)"}`);
  console.log(`convention: ${charter.conventionPreset ?? "(none)"}`);
  console.log(`tools: ${charter.tools.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`roster: ${charter.roster.map((r) => r.role ? `${r.agent} (${r.role})` : r.agent).join(", ") || "(none)"}`);

  const agents = agentsToLaunch(flags, charter.roster);

  console.log("");

  const tmux = detectMultiplexer("tmux");
  const useWorkspace = !flags.detached && Boolean(tmux);

  if (flags.dryRun) {
    const plan = planWorkspace(room, agents, { monitor: flags.monitor });
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
      const { plan, result } = openWorkspace(room, agents, { monitor: flags.monitor });
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

      await reportJoins(db, room, plan.agents);

      if (!sessionExists(tmux!, result.session)) {
        console.log("nothing to attach to: no agent was launched and no workspace exists.");
        return;
      }
      // A piped or non-interactive run has no terminal to hand over, so it
      // prints the command instead of failing inside tmux.
      if (!canAttach()) {
        console.log(`\nattach with:  ${result.attachWith}`);
        return;
      }
      const attached = attachWorkspace(tmux!, result.session, {
        insideMultiplexer: insideMultiplexer(),
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
    const result = invite(room, agent, {});
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
    serve();
    break;
  case "status":
    await status(process.argv.includes("--json"));
    break;
  case "rooms":
    rooms(arg);
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
    await runConsole(arg, { baseUrl: `http://127.0.0.1:${port()}` });
    break;
  case "agents":
    agents(arg);
    break;
  case "close":
    close(arg);
    break;
  case "hooks":
    hooks(process.argv.includes("--json"));
    break;
  case "tools":
    tools(process.argv.includes("--json"));
    break;
  default:
    console.error(
      "usage: ai-room <serve|status [--json]|tools [--json]|hooks [--json]|" +
        "console <room>|open <room> [flags]|close <room>|agents <room>|" +
        "rooms [query]|messages <room>|who <room>>"
    );
    process.exit(1);
}
