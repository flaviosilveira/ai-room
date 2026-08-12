import type Database from "better-sqlite3";
import type { MessageInfo, ParticipantInfo, RoomInfo } from "./types.js";

function ensureRoom(db: Database.Database, room: string): RoomInfo {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (name, created_at) VALUES (?, ?)
     ON CONFLICT(name) DO NOTHING`
  ).run(room, now);
  const row = db
    .prepare(`SELECT name, created_at as createdAt FROM rooms WHERE name = ?`)
    .get(room) as RoomInfo;
  return row;
}

function ensureParticipant(
  db: Database.Database,
  room: string,
  agent: string,
  role: string | null
): ParticipantInfo {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT 1 FROM participants WHERE room = ? AND agent = ?`)
    .get(room, agent);

  if (existing) {
    db.prepare(
      `UPDATE participants
       SET last_seen_at = ?, active = 1, role = COALESCE(?, role)
       WHERE room = ? AND agent = ?`
    ).run(now, role, room, agent);
  } else {
    db.prepare(
      `INSERT INTO participants (room, agent, role, joined_at, last_seen_at, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(room, agent, role, now, now);

    // New participants start listening from "now" — they don't get flooded
    // with pre-existing history through room_listen (use room_history for that).
    const maxId = db
      .prepare(
        `SELECT COALESCE(MAX(id), 0) as maxId FROM messages WHERE room = ?`
      )
      .get(room) as { maxId: number };
    db.prepare(
      `INSERT INTO cursors (room, agent, last_message_id) VALUES (?, ?, ?)`
    ).run(room, agent, maxId.maxId);
  }

  return getParticipant(db, room, agent)!;
}

function getParticipant(
  db: Database.Database,
  room: string,
  agent: string
): ParticipantInfo | null {
  const row = db
    .prepare(
      `SELECT room, agent, role, joined_at as joinedAt, last_seen_at as lastSeenAt, active
       FROM participants WHERE room = ? AND agent = ?`
    )
    .get(room, agent) as
    | (Omit<ParticipantInfo, "active"> & { active: number })
    | undefined;
  if (!row) return null;
  return { ...row, active: !!row.active };
}

export function roomJoin(
  db: Database.Database,
  params: { room: string; agent: string; role?: string }
): { room: RoomInfo; participant: ParticipantInfo } {
  const room = ensureRoom(db, params.room);
  const participant = ensureParticipant(
    db,
    params.room,
    params.agent,
    params.role ?? null
  );
  return { room, participant };
}

export function roomSend(
  db: Database.Database,
  params: { room: string; agent: string; message: string }
): MessageInfo {
  ensureRoom(db, params.room);
  ensureParticipant(db, params.room, params.agent, null);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (room, agent, content, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(params.room, params.agent, params.message, now);

  db.prepare(`UPDATE participants SET last_seen_at = ? WHERE room = ? AND agent = ?`).run(
    now,
    params.room,
    params.agent
  );

  return {
    id: Number(info.lastInsertRowid),
    room: params.room,
    agent: params.agent,
    content: params.message,
    createdAt: now,
  };
}

export function roomListen(
  db: Database.Database,
  params: { room: string; agent: string }
): MessageInfo[] {
  ensureRoom(db, params.room);
  ensureParticipant(db, params.room, params.agent, null);

  const listen = db.transaction((room: string, agent: string) => {
    const cursor = db
      .prepare(
        `SELECT last_message_id as lastMessageId FROM cursors WHERE room = ? AND agent = ?`
      )
      .get(room, agent) as { lastMessageId: number };

    const rows = db
      .prepare(
        `SELECT id, room, agent, content, created_at as createdAt
         FROM messages
         WHERE room = ? AND id > ? AND agent != ?
         ORDER BY id ASC`
      )
      .all(room, cursor.lastMessageId, agent) as MessageInfo[];

    // Advance the cursor past every message up to "now" (not just the ones
    // returned), so a re-send by this same agent never later appears as new.
    const maxId = db
      .prepare(`SELECT COALESCE(MAX(id), ?) as maxId FROM messages WHERE room = ?`)
      .get(cursor.lastMessageId, room) as { maxId: number };

    if (maxId.maxId > cursor.lastMessageId) {
      db.prepare(
        `UPDATE cursors SET last_message_id = ? WHERE room = ? AND agent = ?`
      ).run(maxId.maxId, room, agent);
    }

    db.prepare(
      `UPDATE participants SET last_seen_at = ? WHERE room = ? AND agent = ?`
    ).run(Date.now(), room, agent);

    return rows;
  });

  return listen(params.room, params.agent);
}

export function roomHistory(
  db: Database.Database,
  params: {
    room: string;
    limit?: number;
    after?: number;
    before?: number;
    agent?: string;
  }
): MessageInfo[] {
  const clauses = ["room = ?"];
  const args: unknown[] = [params.room];

  if (params.after !== undefined) {
    clauses.push("id > ?");
    args.push(params.after);
  }
  if (params.before !== undefined) {
    clauses.push("id < ?");
    args.push(params.before);
  }
  if (params.agent !== undefined) {
    clauses.push("agent = ?");
    args.push(params.agent);
  }

  const limit = params.limit ?? 50;
  args.push(limit);

  const rows = db
    .prepare(
      `SELECT id, room, agent, content, created_at as createdAt
       FROM messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(...args) as MessageInfo[];

  return rows;
}

export function roomWho(
  db: Database.Database,
  params: { room: string }
): ParticipantInfo[] {
  const rows = db
    .prepare(
      `SELECT room, agent, role, joined_at as joinedAt, last_seen_at as lastSeenAt, active
       FROM participants WHERE room = ? ORDER BY last_seen_at DESC`
    )
    .all(params.room) as (Omit<ParticipantInfo, "active"> & { active: number })[];

  return rows.map((row) => ({ ...row, active: !!row.active }));
}

export function roomLeave(
  db: Database.Database,
  params: { room: string; agent: string }
): void {
  db.prepare(
    `UPDATE participants SET active = 0, last_seen_at = ? WHERE room = ? AND agent = ?`
  ).run(Date.now(), params.room, params.agent);
}
