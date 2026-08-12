import { openDb, defaultDbPath } from "./db/index.js";
import { createHttpApp } from "./http.js";
import { roomHistory, roomWho } from "./store.js";

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

function status(): void {
  console.log(`db: ${defaultDbPath()}`);
  console.log(`expected port: ${port()}`);
}

function rooms(): void {
  const db = openDb();
  const rows = db.prepare(`SELECT name, created_at as createdAt FROM rooms ORDER BY created_at`).all();
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
    status();
    break;
  case "rooms":
    rooms();
    break;
  case "messages":
    messages(arg);
    break;
  case "who":
    who(arg);
    break;
  default:
    console.error("usage: ai-room <serve|status|rooms|messages <room>|who <room>>");
    process.exit(1);
}
