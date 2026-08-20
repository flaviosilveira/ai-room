import type Database from "better-sqlite3";
import type {
  AgentStatus,
  MessageInfo,
  ParticipantInfo,
  RoomInfo,
  RoomListInfo,
} from "./types.js";

function ensureRoom(
  db: Database.Database,
  room: string,
  createIfMissing = true
): { room: RoomInfo; created: boolean } {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO rooms (name, created_at) VALUES (?, ?)
     ON CONFLICT(name) DO NOTHING`
  );
  const insert = createIfMissing ? result.run(room, now) : null;
  const row = db
    .prepare(`SELECT name, created_at as createdAt FROM rooms WHERE name = ?`)
    .get(room) as RoomInfo | undefined;
  if (!row) {
    throw new Error(
      `Room "${room}" does not exist. Use room_list with a query before joining a persistent workspace.`
    );
  }
  return { room: row, created: insert?.changes === 1 };
}

function ensureParticipant(
  db: Database.Database,
  room: string,
  agent: string,
  role: string | null,
  explicitJoin = false
): ParticipantInfo {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT 1 FROM participants WHERE room = ? AND agent = ?`)
    .get(room, agent);

  if (existing) {
    db.prepare(
      `UPDATE participants
       SET last_seen_at = ?, active = 1, role = COALESCE(?, role),
           status = CASE WHEN ? = 1 OR status = 'done' THEN 'working' ELSE status END,
           status_detail = CASE WHEN ? = 1 OR status = 'done' THEN NULL ELSE status_detail END,
           status_updated_at = CASE WHEN ? = 1 OR status = 'done' THEN ? ELSE status_updated_at END
       WHERE room = ? AND agent = ?`
    ).run(
      now,
      role,
      explicitJoin ? 1 : 0,
      explicitJoin ? 1 : 0,
      explicitJoin ? 1 : 0,
      now,
      room,
      agent
    );
  } else {
    db.prepare(
      `INSERT INTO participants
         (room, agent, role, joined_at, last_seen_at, active, status, status_updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'working', ?)`
    ).run(room, agent, role, now, now, now);

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
      `SELECT room, agent, role, joined_at as joinedAt, last_seen_at as lastSeenAt, active,
              status, status_detail as statusDetail, status_updated_at as statusUpdatedAt
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
  params: { room: string; agent: string; role?: string; createIfMissing?: boolean }
): { room: RoomInfo; participant: ParticipantInfo; created: boolean } {
  const result = ensureRoom(db, params.room, params.createIfMissing ?? true);
  const participant = ensureParticipant(
    db,
    params.room,
    params.agent,
    params.role ?? null,
    true
  );
  return { room: result.room, participant, created: result.created };
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
      `INSERT INTO messages (room, agent, origin, content, created_at)
       VALUES (?, ?, 'agent', ?, ?)`
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
    origin: "agent",
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
        `SELECT id, room, agent, origin, content, created_at as createdAt
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
      `SELECT id, room, agent, origin, content, created_at as createdAt
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
      `SELECT room, agent, role, joined_at as joinedAt, last_seen_at as lastSeenAt, active,
              status, status_detail as statusDetail, status_updated_at as statusUpdatedAt
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
    `UPDATE participants
     SET active = 0, last_seen_at = ?, status = 'done', status_detail = NULL,
         status_updated_at = ?
     WHERE room = ? AND agent = ?`
  ).run(Date.now(), Date.now(), params.room, params.agent);
}

export function roomList(
  db: Database.Database,
  params: { query?: string; limit?: number }
): RoomListInfo[] {
  const tokens = (params.query ?? "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const clauses = tokens.map(() => `LOWER(r.name) LIKE ? ESCAPE '\\'`);
  const escapeLike = (token: string) => token.replace(/[\\%_]/g, "\\$&");
  const args: unknown[] = tokens.map((token) => `%${escapeLike(token)}%`);
  args.push(params.limit ?? 50);

  return db
    .prepare(
      `SELECT r.name, r.created_at as createdAt,
              MAX(r.created_at, COALESCE(MAX(m.created_at), 0), COALESCE(MAX(p.last_seen_at), 0))
                as lastActivityAt,
              COUNT(DISTINCT p.agent) as participantCount,
              COUNT(DISTINCT CASE WHEN p.active = 1 THEN p.agent END) as activeParticipantCount
       FROM rooms r
       LEFT JOIN messages m ON m.room = r.name
       LEFT JOIN participants p ON p.room = r.name
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       GROUP BY r.name, r.created_at
       ORDER BY lastActivityAt DESC, r.name ASC
       LIMIT ?`
    )
    .all(...args) as RoomListInfo[];
}

export function roomSetStatus(
  db: Database.Database,
  params: { room: string; agent: string; status: AgentStatus; detail?: string | null }
): ParticipantInfo {
  ensureRoom(db, params.room, false);
  const participant = getParticipant(db, params.room, params.agent);
  if (!participant) {
    throw new Error(`Agent "${params.agent}" has not joined room "${params.room}".`);
  }

  const now = Date.now();
  db.prepare(
    `UPDATE participants
     SET status = ?, status_detail = ?, status_updated_at = ?, last_seen_at = ?,
         active = CASE WHEN ? = 'done' THEN 0 ELSE 1 END
     WHERE room = ? AND agent = ?`
  ).run(params.status, params.detail ?? null, now, now, params.status, params.room, params.agent);
  return getParticipant(db, params.room, params.agent)!;
}
