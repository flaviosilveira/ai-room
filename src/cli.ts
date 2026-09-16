import { openDb, defaultDbPath } from "./db/index.js";
import { VERSION } from "./version.js";
import { createHttpApp } from "./http.js";
import { roomHistory, roomJoin, roomList, roomSetCharter, roomWho } from "./store.js";
import { closeRoom, invite, openWorkspace, planWorkspace } from "./invite.js";
import { runConsole } from "./console.js";
import {
  INSTALL_HINT,
  detectMultiplexer,
  liveSessions,
  sessionName,
} from "./session.js";
import { TOOL_CATALOG } from "./catalog.js";
import type { RosterEntry } from "./types.js";
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


interface OpenFlags {
  brief?: string;
  convention?: string;
  tools: string[];
  invite: string[];
  roles: Map<string, string>;
  dryRun: boolean;
  detached: boolean;
  monitor: boolean;
}

function parseOpenFlags(argv: string[]): OpenFlags {
  const flags: OpenFlags = {
    tools: [],
    invite: [],
    roles: new Map(),
    dryRun: false,
    detached: false,
    monitor: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? "";
    if (arg === "--brief") flags.brief = value();
    else if (arg === "--convention") flags.convention = value();
    else if (arg === "--tool") flags.tools.push(...value().split(",").filter(Boolean));
    else if (arg === "--invite") flags.invite.push(...value().split(",").filter(Boolean));
    else if (arg === "--role") {
      const [agent, ...rest] = value().split("=");
      if (agent && rest.length) flags.roles.set(agent, rest.join("="));
    } else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--detached") flags.detached = true;
    else if (arg === "--no-monitor") flags.monitor = false;
    else throw new Error(`Unknown flag "${arg}"`);
  }
  return flags;
}

/**
 * One command replaces the two messages a human otherwise retypes: it creates
 * the room with a charter, then launches each invited agent with a seed prompt
 * that makes it join and read that charter.
 */
function open(room: string, argv: string[]): void {
  if (!room) {
    console.error(
      'usage: ai-room open <room> [--brief "..."] [--convention caveman] [--tool graphify]\n' +
        "                       [--invite codex,agy] [--role codex=reviewer] [--dry-run]"
    );
    process.exit(1);
  }

  const flags = parseOpenFlags(argv);
  const db = openDb();

  roomJoin(db, { room, agent: "human", role: "host" });

  const roster: RosterEntry[] = flags.invite.map((agent) => ({
    agent,
    role: flags.roles.get(agent),
  }));
  const charter = roomSetCharter(db, {
    room,
    brief: flags.brief ?? null,
    conventionPreset: flags.convention ?? null,
    tools: flags.tools,
    roster,
  });

  console.log(`room: ${room}`);
  console.log(`brief: ${charter.brief ?? "(none)"}`);
  console.log(`convention: ${charter.conventionPreset ?? "(none)"}`);
  console.log(`tools: ${charter.tools.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`roster: ${charter.roster.map((r) => r.role ? `${r.agent} (${r.role})` : r.agent).join(", ") || "(none)"}`);

  if (!flags.invite.length) {
    console.log("invited: nobody");
    return;
  }

  console.log("");

  const tmux = detectMultiplexer("tmux");
  const useWorkspace = !flags.detached && Boolean(tmux);

  if (flags.dryRun) {
    const plan = planWorkspace(room, flags.invite, { monitor: flags.monitor });
    console.log(`mode: ${useWorkspace ? "tmux workspace" : flags.detached ? "detached" : "detached (no tmux)"}`);
    for (const pane of plan.panes) {
      console.log(`  ${pane.title}: ${pane.command.join(" ")}`);
    }
    if (plan.missing.length) console.log(`  not installed: ${plan.missing.join(", ")}`);
    return;
  }

  if (useWorkspace) {
    try {
      const { plan, result } = openWorkspace(room, flags.invite, { monitor: flags.monitor });
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
      console.log(`\nattach with:  ${result.attachWith}`);
      return;
    } catch (error) {
      console.error(`workspace failed: ${error instanceof Error ? error.message : error}`);
      console.error("falling back to detached sessions.");
      process.exitCode = 1;
    }
  } else if (!flags.detached && !tmux) {
    console.log(`tmux not found, using detached sessions. ${INSTALL_HINT}\n`);
  }

  for (const agent of flags.invite) {
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
    open(arg, process.argv.slice(4));
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
  case "tools":
    tools(process.argv.includes("--json"));
    break;
  default:
    console.error(
      "usage: ai-room <serve|status [--json]|tools [--json]|console <room>|" +
        "open <room> [flags]|close <room>|agents <room>|rooms [query]|" +
        "messages <room>|who <room>>"
    );
    process.exit(1);
}
