import type Database from "better-sqlite3";
import { resolveConvention, resolveTool } from "./presets.js";
import type {
  ActiveRoomInfo,
  WakeSpec,
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
  explicitJoin = false,
  harness: string | null = null
): ParticipantInfo {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT 1 FROM participants WHERE room = ? AND agent = ?`)
    .get(room, agent);

  if (existing) {
    // Any call from the agent means its turn is running, so it is no longer
    // idle: leaving the row idle would let the monitor show a sleeping agent
    // that is working, and let the room "resume" a session already awake.
    db.prepare(
      `UPDATE participants
       SET last_seen_at = ?, active = 1, role = COALESCE(?, role),
           harness = COALESCE(?, harness),
           wake_kind = CASE WHEN status = 'idle' THEN NULL ELSE wake_kind END,
           wake_id = CASE WHEN status = 'idle' THEN NULL ELSE wake_id END,
           status = CASE
                      WHEN ? = 1 OR status = 'done' THEN 'working'
                      WHEN status = 'idle' THEN 'working'
                      ELSE status
                    END,
           status_detail = CASE WHEN ? = 1 OR status IN ('done', 'idle') THEN NULL ELSE status_detail END,
           status_updated_at = CASE WHEN ? = 1 OR status IN ('done', 'idle') THEN ? ELSE status_updated_at END
       WHERE room = ? AND agent = ?`
    ).run(
      now,
      role,
      harness,
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
         (room, agent, harness, role, joined_at, last_seen_at, active, status, status_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'working', ?)`
    ).run(room, agent, harness, role, now, now, now);

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

interface ParticipantRow extends Omit<ParticipantInfo, "active" | "wake"> {
  active: number;
  wakeKind: string | null;
  wakeId: string | null;
}

function toParticipant(row: ParticipantRow): ParticipantInfo {
  const { wakeKind, wakeId, ...rest } = row;
  return {
    ...rest,
    active: !!row.active,
    wake: wakeKind && wakeId ? { kind: wakeKind as WakeSpec["kind"], id: wakeId } : null,
  };
}

const PARTICIPANT_COLUMNS = `room, agent, harness, role, joined_at as joinedAt,
        last_seen_at as lastSeenAt, active, status, status_detail as statusDetail,
        status_updated_at as statusUpdatedAt, wake_kind as wakeKind, wake_id as wakeId,
        wake_error as wakeError`;

function getParticipant(
  db: Database.Database,
  room: string,
  agent: string
): ParticipantInfo | null {
  const row = db
    .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM participants WHERE room = ? AND agent = ?`)
    .get(room, agent) as ParticipantRow | undefined;
  return row ? toParticipant(row) : null;
}

export function roomJoin(
  db: Database.Database,
  params: {
    room: string;
    agent: string;
    role?: string;
    harness?: string;
    createIfMissing?: boolean;
  }
): {
  room: RoomInfo;
  participant: ParticipantInfo;
  created: boolean;
  briefing: AgentBriefing | null;
  nextAction: string;
} {
  const result = ensureRoom(db, params.room, params.createIfMissing ?? true);

  // The charter's roster stays the single source of truth for roles; the
  // participant row only mirrors it, so `room_who` can show who is playing what
  // without a second lookup. An explicit role argument still wins.
  const rosterEntry = roomCharter(db, params.room)?.roster.find(
    (entry) => entry.agent === params.agent
  );

  const participant = ensureParticipant(
    db,
    params.room,
    params.agent,
    params.role ?? rosterEntry?.role ?? null,
    true,
    params.harness ?? rosterEntry?.harness ?? null
  );
  const briefing = roomBriefing(db, params.room, params.agent);
  return {
    room: result.room,
    participant,
    created: result.created,
    briefing,
    // Joining is not the job. Without this an agent reads a perfectly good
    // briefing and parks in room_wait, and the room stays silent until a human
    // tells it to start — which is exactly what the charter exists to avoid.
    nextAction: briefing
      ? "Start now: do the work your role in the briefing calls for, and publish what you are doing with room_send. Call room_wait only once you are blocked or waiting on a teammate."
      : "No charter is set for this room. Ask in room_send what the room is for, then call room_wait.",
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

/**
 * Marks everything up to `upToId` as seen by `agent`, without returning it.
 *
 * The console reads the room over the live feed, never through room_listen, so
 * the human's cursor never moved and the monitor showed a human with dozens of
 * "unread" messages it had been watching scroll by all along.
 */
export function markRead(
  db: Database.Database,
  params: { room: string; agent: string; upToId: number }
): void {
  // Only for a viewer that reads by watching. An agent's cursor is what decides
  // whether it gets resumed, so a feed opened under its name must not advance
  // it — that would be the room deciding the agent had read something.
  const participant = getParticipant(db, params.room, params.agent);
  if (participant?.wake || participant?.status === "idle") return;

  const row = db
    .prepare(`SELECT last_message_id as lastMessageId FROM cursors WHERE room = ? AND agent = ?`)
    .get(params.room, params.agent) as { lastMessageId: number } | undefined;
  if (row === undefined) {
    // No cursor row means this viewer never joined; nothing to track for it.
    if (!participant) return;
    db.prepare(`INSERT INTO cursors (room, agent, last_message_id) VALUES (?, ?, ?)`).run(
      params.room,
      params.agent,
      params.upToId
    );
    return;
  }
  if (params.upToId > row.lastMessageId) {
    db.prepare(`UPDATE cursors SET last_message_id = ? WHERE room = ? AND agent = ?`).run(
      params.upToId,
      params.room,
      params.agent
    );
  }
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

/**
 * `unread` is counted here rather than reported by the agent: cursors are the
 * server's own record, so it is the one delivery fact nobody can misstate.
 * Wait liveness lives in the wait registry, so callers that have it decorate
 * these rows with `waitActive`.
 */
/**
 * An agent goes idle by ending its turn, which means it can no longer notice
 * anything by itself. It registers how it can be resumed first; without that
 * target there is nothing to wake and idle would be indistinguishable from gone.
 */
export function roomIdle(
  db: Database.Database,
  params: { room: string; agent: string; wake: WakeSpec; detail?: string | null }
): ParticipantInfo {
  ensureRoom(db, params.room, false);
  const existing = getParticipant(db, params.room, params.agent);
  if (!existing) {
    throw new Error(`Agent "${params.agent}" has not joined room "${params.room}".`);
  }
  const now = Date.now();
  // The mark is what this agent has actually read, not what exists: a message
  // that landed between its last drain and this call was never seen, and using
  // MAX(id) here would bury it until somebody else happened to speak.
  const latest = db
    .prepare(`SELECT COALESCE(last_message_id, 0) as id FROM cursors WHERE room = ? AND agent = ?`)
    .get(params.room, params.agent) as { id: number } | undefined;
  db.prepare(
    `UPDATE participants
     SET status = 'idle', status_detail = ?, status_updated_at = ?, last_seen_at = ?,
         active = 1, wake_kind = ?, wake_id = ?, wake_error = NULL, idle_mark = ?
     WHERE room = ? AND agent = ?`
  ).run(
    params.detail ?? null,
    now,
    now,
    params.wake.kind,
    params.wake.id,
    latest?.id ?? 0,
    params.room,
    params.agent
  );
  return getParticipant(db, params.room, params.agent)!;
}

export interface WakeTarget {
  agent: string;
  wakeKind: WakeSpec["kind"];
  wakeId: string;
  unread: number;
  /** The agent's read position when this target was selected. */
  cursor: number;
}

/** Idle agents in this room that have something to come back for. */
export function idleParticipantsWithUnread(
  db: Database.Database,
  room: string
): WakeTarget[] {
  return db
    .prepare(
      `SELECT p.agent, p.wake_kind as wakeKind, p.wake_id as wakeId,
              COALESCE((SELECT c.last_message_id FROM cursors c
                         WHERE c.room = p.room AND c.agent = p.agent), 0) as cursor,
              (SELECT COUNT(*) FROM messages m
                WHERE m.room = p.room AND m.agent != p.agent
                  AND m.id > COALESCE((SELECT c.last_message_id FROM cursors c
                                        WHERE c.room = p.room AND c.agent = p.agent), 0)
              ) as unread
       FROM participants p
       WHERE p.room = ? AND p.active = 1 AND p.status = 'idle'
         AND p.wake_kind IS NOT NULL AND p.wake_id IS NOT NULL
         -- Something it has not read, that arrived after it fell asleep.
         AND EXISTS (SELECT 1 FROM messages m
                      WHERE m.room = p.room AND m.agent != p.agent AND m.id > p.idle_mark)
         -- And it has not already been resumed twice for this same position.
         AND (p.wake_cursor != COALESCE((SELECT c.last_message_id FROM cursors c
                                          WHERE c.room = p.room AND c.agent = p.agent), 0)
              OR p.wake_attempts < ${WAKE_ATTEMPT_LIMIT})`
    )
    .all(room) as WakeTarget[];
}

/**
 * Counts one resume against the agent's current read position. The counter
 * resets as soon as it reads something, so an agent that keeps up is never
 * throttled, and one that ignores the room stops being resumed.
 */
export function recordWakeAttempt(
  db: Database.Database,
  room: string,
  agent: string,
  cursor: number
): void {
  db.prepare(
    `UPDATE participants
     SET wake_attempts = CASE WHEN wake_cursor = ? THEN wake_attempts + 1 ELSE 1 END,
         wake_cursor = ?
     WHERE room = ? AND agent = ?`
  ).run(cursor, cursor, room, agent);
}

/**
 * How many times an agent may be resumed without reading anything before the
 * room stops trying. Waking is cheap for the server and expensive for the
 * agent: two ignored resumes are a problem to show, not to repeat.
 */
export const WAKE_ATTEMPT_LIMIT = 2;

/** Records the outcome of a wake so a silent failure cannot look like sleep. */
export function touchWake(
  db: Database.Database,
  room: string,
  agent: string,
  ok: boolean,
  error?: string
): void {
  db.prepare(`UPDATE participants SET wake_error = ? WHERE room = ? AND agent = ?`).run(
    ok ? null : (error ?? "wake failed").slice(0, 300),
    room,
    agent
  );
}

export function roomMessageCount(db: Database.Database, room: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE room = ?`).get(room) as {
    count: number;
  };
  return row.count;
}

export function roomExists(db: Database.Database, room: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM rooms WHERE name = ?`).get(room));
}

export function roomWho(
  db: Database.Database,
  params: { room: string }
): (ParticipantInfo & { unread: number })[] {
  const rows = db
    .prepare(
      `SELECT p.room, p.agent, p.harness, p.role, p.joined_at as joinedAt,
              p.last_seen_at as lastSeenAt, p.active, p.status, p.status_detail as statusDetail,
              p.status_updated_at as statusUpdatedAt, p.wake_kind as wakeKind,
              p.wake_id as wakeId, p.wake_error as wakeError,
              (SELECT COUNT(*) FROM messages m
                WHERE m.room = p.room
                  AND m.agent != p.agent
                  AND m.id > COALESCE(
                        (SELECT c.last_message_id FROM cursors c
                          WHERE c.room = p.room AND c.agent = p.agent), 0)
              ) as unread
       FROM participants p WHERE p.room = ? ORDER BY p.last_seen_at DESC`
    )
    .all(params.room) as (ParticipantRow & { unread: number })[];

  return rows.map((row) => ({ ...toParticipant(row), unread: row.unread }));
}

export function roomLeave(
  db: Database.Database,
  params: { room: string; agent: string }
): void {
  db.prepare(
    `UPDATE participants
     SET active = 0, last_seen_at = ?, status = 'done', status_detail = NULL,
         status_updated_at = ?, wake_kind = NULL, wake_id = NULL, wake_error = NULL
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
  // Any status other than idle means a turn is running, so the wake target is
  // stale: the agent is already awake and will register again when it stops.
  db.prepare(
    `UPDATE participants
     SET status = ?, status_detail = ?, status_updated_at = ?, last_seen_at = ?,
         active = CASE WHEN ? = 'done' THEN 0 ELSE 1 END,
         wake_kind = CASE WHEN ? = 'idle' THEN wake_kind ELSE NULL END,
         wake_id = CASE WHEN ? = 'idle' THEN wake_id ELSE NULL END
     WHERE room = ? AND agent = ?`
  ).run(
    params.status,
    params.detail ?? null,
    now,
    now,
    params.status,
    params.status,
    params.status,
    params.room,
    params.agent
  );
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
              (p.wake_kind IS NOT NULL AND p.wake_id IS NOT NULL) as wakeRegistered,
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
