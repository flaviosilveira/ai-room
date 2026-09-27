import type Database from "better-sqlite3";
import { roomSend } from "./store.js";

/**
 * What an agent was stopped from doing, waiting for the human. The gate hook
 * blocks the action and files it here; the human allows or denies it from the
 * console, and only from there: the HTTP side can ask, never answer. An
 * allowed request is spent by the one retry it was granted for.
 */
export interface Approval {
  id: number;
  room: string;
  agent: string;
  action: string;
  reason: string | null;
  status: "pending" | "allowed" | "denied" | "used";
  createdAt: number;
}

const COLUMNS = "id, room, agent, action, reason, status, created_at as createdAt";

export function requestApproval(
  db: Database.Database,
  params: { room: string; agent: string; action: string; reason?: string }
): { status: "allowed" | "pending" | "denied"; id: number } {
  return db.transaction(() => {
    const previous = db
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE room = ? AND agent = ? AND action = ? AND status != 'used' ORDER BY id DESC LIMIT 1`)
      .get(params.room, params.agent, params.action) as Approval | undefined;
    if (previous?.status === "allowed") {
      db.prepare("UPDATE approvals SET status = 'used' WHERE id = ?").run(previous.id);
      return { status: "allowed" as const, id: previous.id };
    }
    if (previous) return { status: previous.status as "pending" | "denied", id: previous.id };

    const id = Number(
      db.prepare("INSERT INTO approvals (room, agent, action, reason, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(params.room, params.agent, params.action, params.reason ?? null, Date.now()).lastInsertRowid
    );
    roomSend(db, {
      room: params.room,
      agent: params.agent,
      origin: "system",
      to: ["human"],
      message: `${params.agent} needs your approval #${id}: ${params.action}${params.reason ? ` (${params.reason})` : ""}. /allow ${id} or /deny ${id}`,
    });
    return { status: "pending" as const, id };
  })();
}

export function pendingApprovals(db: Database.Database, room: string): Approval[] {
  return db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE room = ? AND status = 'pending' ORDER BY id`).all(room) as Approval[];
}

/** The human's answer. A denied request can still be allowed later; a used one is done. */
export function decideApproval(db: Database.Database, room: string, id: number, allow: boolean): Approval | null {
  const changed = db
    .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND room = ? AND status IN ('pending', 'denied')")
    .run(allow ? "allowed" : "denied", Date.now(), id, room).changes;
  if (!changed) return null;
  const approval = db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).get(id) as Approval;
  roomSend(db, {
    room,
    agent: "human",
    origin: "human",
    to: [approval.agent],
    message: allow
      ? `Approved #${id}: ${approval.action}. Run it again now; it is allowed once.`
      : `Denied #${id}: ${approval.action}. Do not run it; find another way or ask the human.`,
  });
  return approval;
}
