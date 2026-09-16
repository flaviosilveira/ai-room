import type Database from "better-sqlite3";
import { resolveConvention, resolveTool } from "./presets.js";
import type {
  ActiveRoomInfo,
  AgentBriefing,
  RoomCharter,
  RosterEntry,
  ToolDeclaration,
  AgentStatus,
  MessageInfo,
  ParticipantInfo,
  RoomInfo,
  RoomListInfo,
} from "./types.js";

function ensureRoom(
  db: Database.Database,
  room: string,
  createIfMissing = true,
  hint = "Use room_list with a query before joining a persistent workspace."
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
    throw new Error(`Room "${room}" does not exist. ${hint}`);
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
): {
  room: RoomInfo;
  participant: ParticipantInfo;
  created: boolean;
  briefing: AgentBriefing | null;
} {
  const result = ensureRoom(db, params.room, params.createIfMissing ?? true);
  const participant = ensureParticipant(
    db,
    params.room,
    params.agent,
    params.role ?? null,
    true
  );
  return {
    room: result.room,
    participant,
    created: result.created,
    briefing: roomBriefing(db, params.room, params.agent),
  };
}

export function roomSend(
  db: Database.Database,
  params: {
    room: string;
    agent: string;
    message: string;
    /**
     * Server-controlled. Only the human console writes "human"; agents can never
     * claim it, which is what keeps `origin` trustworthy as an authority signal.
     */
    origin?: MessageInfo["origin"];
  }
): MessageInfo {
  const origin = params.origin ?? "agent";
  ensureRoom(db, params.room, false, "Call room_join first; room_send never creates a room, so a typo cannot silently fork the conversation.");
  ensureParticipant(db, params.room, params.agent, null);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (room, agent, origin, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(params.room, params.agent, origin, params.message, now);

  db.prepare(`UPDATE participants SET last_seen_at = ? WHERE room = ? AND agent = ?`).run(
    now,
    params.room,
    params.agent
  );

  return {
    id: Number(info.lastInsertRowid),
    room: params.room,
    agent: params.agent,
    origin,
    content: params.message,
    createdAt: now,
  };
}

export function roomListen(
  db: Database.Database,
  params: { room: string; agent: string }
): MessageInfo[] {
  ensureRoom(db, params.room, false, "Call room_join first; room_listen never creates a room.");
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

  // Paging forward from `after` takes the OLDEST matches past that id; every
  // other call takes the NEWEST matches. Selecting the oldest N by default made
  // `room_history(limit: 50)` on a busy room return message 1..50 — the start of
  // the conversation — rather than what was just said.
  const pageForward = params.after !== undefined && params.before === undefined;

  const rows = db
    .prepare(
      `SELECT id, room, agent, origin, content, createdAt FROM (
         SELECT id, room, agent, origin, content, created_at as createdAt
         FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY id ${pageForward ? "ASC" : "DESC"}
         LIMIT ?
       )
       ORDER BY id ASC`
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

/**
 * Rooms where `agent` is still an active participant, with the number of
 * messages it has not yet consumed. Backs `GET /active`, which harness stop
 * hooks poll to decide whether an agent is allowed to end its turn.
 */
export function agentActiveRooms(
  db: Database.Database,
  agent: string
): ActiveRoomInfo[] {
  return db
    .prepare(
      `SELECT p.room, p.role, p.status, p.status_detail as statusDetail,
              p.last_seen_at as lastSeenAt,
              (SELECT COUNT(*) FROM messages m
                WHERE m.room = p.room
                  AND m.agent != p.agent
                  AND m.id > COALESCE(
                        (SELECT c.last_message_id FROM cursors c
                          WHERE c.room = p.room AND c.agent = p.agent), 0)
              ) as unread
       FROM participants p
       WHERE p.agent = ? AND p.active = 1
       ORDER BY p.last_seen_at DESC`
    )
    .all(agent) as ActiveRoomInfo[];
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface CharterRow {
  room: string;
  brief: string | null;
  conventions: string | null;
  conventionPreset: string | null;
  tools: string | null;
  roster: string | null;
  createdAt: number;
  updatedAt: number;
}

export function roomCharter(
  db: Database.Database,
  room: string
): RoomCharter | null {
  const row = db
    .prepare(
      `SELECT room, brief, conventions, convention_preset as conventionPreset,
              tools, roster, created_at as createdAt, updated_at as updatedAt
       FROM room_profiles WHERE room = ?`
    )
    .get(room) as CharterRow | undefined;
  if (!row) return null;
  return {
    ...row,
    tools: parseJson<ToolDeclaration[]>(row.tools, []),
    roster: parseJson<RosterEntry[]>(row.roster, []),
  };
}

/**
 * The charter as one agent should receive it: the shared parts, plus that
 * agent's own role pulled out of the roster and the teammates it should expect.
 * This is what removes the "you are X, you will help Y" message a human
 * otherwise retypes into every agent.
 */
export function roomBriefing(
  db: Database.Database,
  room: string,
  agent: string
): AgentBriefing | null {
  const charter = roomCharter(db, room);
  if (!charter) return null;
  const you = charter.roster.find((entry) => entry.agent === agent) ?? null;
  return {
    ...charter,
    you,
    teammates: charter.roster.filter((entry) => entry.agent !== agent),
  };
}

export function roomSetCharter(
  db: Database.Database,
  params: {
    room: string;
    brief?: string | null;
    conventionPreset?: string | null;
    conventions?: string | null;
    tools?: (string | ToolDeclaration)[];
    roster?: RosterEntry[];
  }
): RoomCharter {
  ensureRoom(db, params.room, false, "Call room_join first to create it.");

  const existing = roomCharter(db, params.room);
  const now = Date.now();

  // An explicit `conventions` string wins; otherwise a preset name expands to
  // its text. Passing neither leaves whatever the room already had.
  const preset =
    params.conventionPreset !== undefined
      ? params.conventionPreset
      : existing?.conventionPreset ?? null;
  const conventions =
    params.conventions !== undefined
      ? params.conventions
      : params.conventionPreset !== undefined
        ? resolveConvention(preset)
        : existing?.conventions ?? null;

  const tools =
    params.tools !== undefined
      ? params.tools.map((tool) => (typeof tool === "string" ? resolveTool(tool) : tool))
      : existing?.tools ?? [];
  const roster = params.roster !== undefined ? params.roster : existing?.roster ?? [];
  const brief = params.brief !== undefined ? params.brief : existing?.brief ?? null;

  db.prepare(
    `INSERT INTO room_profiles
       (room, brief, conventions, convention_preset, tools, roster, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room) DO UPDATE SET
       brief = excluded.brief,
       conventions = excluded.conventions,
       convention_preset = excluded.convention_preset,
       tools = excluded.tools,
       roster = excluded.roster,
       updated_at = excluded.updated_at`
  ).run(
    params.room,
    brief,
    conventions,
    preset,
    JSON.stringify(tools),
    JSON.stringify(roster),
    existing?.createdAt ?? now,
    now
  );

  return roomCharter(db, params.room)!;
}
