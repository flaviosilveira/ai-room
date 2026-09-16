import { openDb, defaultDbPath } from "./db/index.js";
import { VERSION } from "./version.js";
import { createHttpApp } from "./http.js";
import { roomHistory, roomJoin, roomList, roomSetCharter, roomWho } from "./store.js";
import { invite } from "./invite.js";
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

async function status(): Promise<void> {
  console.log(`db: ${defaultDbPath()}`);
  const baseUrl = `http://127.0.0.1:${port()}`;
  console.log(`url: ${baseUrl}`);

  try {
    const response = await fetch(`${baseUrl}/health`);
    const health = (await response.json()) as {
      ok?: boolean;
      version?: string;
      database?: string;
    };
    if (!response.ok || !health.ok) throw new Error(`health returned HTTP ${response.status}`);
    console.log(`server: reachable`);
    console.log(`version: ${health.version ?? "unknown"}`);
    console.log(`database: ${health.database ?? "unknown"}`);
  } catch (error) {
    console.error(`server: unreachable`);
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ name: "ai-room-status", version: VERSION });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const tools = await client.listTools();
    console.log(`mcp: reachable (${tools.tools.length} tools)`);
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
}

function parseOpenFlags(argv: string[]): OpenFlags {
  const flags: OpenFlags = {
    tools: [],
    invite: [],
    roles: new Map(),
    dryRun: false,
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
  for (const agent of flags.invite) {
    const result = invite(room, agent, { dryRun: flags.dryRun });
    if (flags.dryRun) {
      console.log(`would launch ${agent}: ${result.command}`);
    } else if (result.status === "launched") {
      console.log(`launched ${agent} (pid ${result.pid}) -> ${result.logPath}`);
    } else {
      console.error(`failed ${agent}: ${result.error}`);
      process.exitCode = 1;
    }
  }
}

const [, , cmd, arg] = process.argv;

switch (cmd) {
  case "serve":
    serve();
    break;
  case "status":
    await status();
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
  default:
    console.error(
      "usage: ai-room <serve|status|rooms [query]|messages <room>|who <room>|open <room> [flags]>"
    );
    process.exit(1);
}
