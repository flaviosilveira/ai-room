import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function defaultDbPath(): string {
  return (
    process.env.AI_ROOM_DB_PATH ||
    path.join(os.homedir(), ".ai-room", "ai-room.sqlite")
  );
}

export function openDb(dbPath: string = defaultDbPath()): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      room TEXT NOT NULL REFERENCES rooms(name),
      agent TEXT NOT NULL,
      role TEXT,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'working',
      status_detail TEXT,
      status_updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room, agent)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL REFERENCES rooms(name),
      agent TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'agent',
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id);

    CREATE TABLE IF NOT EXISTS room_profiles (
      room TEXT PRIMARY KEY REFERENCES rooms(name),
      brief TEXT,
      conventions TEXT,
      convention_preset TEXT,
      tools TEXT,
      roster TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cursors (
      room TEXT NOT NULL REFERENCES rooms(name),
      agent TEXT NOT NULL,
      last_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room, agent)
    );
  `);

  ensureColumn(db, "participants", "status", "TEXT NOT NULL DEFAULT 'working'");
  ensureColumn(db, "participants", "status_detail", "TEXT");
  ensureColumn(db, "participants", "status_updated_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "messages", "origin", "TEXT NOT NULL DEFAULT 'agent'");

  db.prepare(
    `UPDATE participants SET status_updated_at = last_seen_at WHERE status_updated_at = 0`
  ).run();
}

function ensureColumn(
  db: Database.Database,
  table: "participants" | "messages",
  column: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
