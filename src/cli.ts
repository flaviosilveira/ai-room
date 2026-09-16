import { openDb, defaultDbPath } from "./db/index.js";
import { VERSION } from "./version.js";
import { createHttpApp } from "./http.js";
import { roomHistory, roomList, roomWho } from "./store.js";
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
  default:
    console.error("usage: ai-room <serve|status|rooms [query]|messages <room>|who <room>>");
    process.exit(1);
}
