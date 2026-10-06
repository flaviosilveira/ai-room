import type Database from "better-sqlite3";
import { roomLeads, roomSend } from "./store.js";

/**
 * What an agent was stopped from doing, waiting for an answer. The gate hook
 * blocks the action and files it here with a tier it worked out itself:
 * `human` for production, secrets and anything that cannot be undone, `lead`
 * for what is merely unusual. The room's lead may answer a `lead` request; a
 * `human` one only the human answers, from the console. An allowed request is
 * spent by the one retry it was granted for.
 */
export type ApprovalTier = "human" | "lead";

export interface Approval {
  id: number;
  room: string;
  agent: string;
  action: string;
  reason: string | null;
  tier: ApprovalTier;
  status: "pending" | "allowed" | "denied" | "used";
  decidedBy: string | null;
  createdAt: number;
}

const COLUMNS = "id, room, agent, action, reason, tier, status, decided_by as decidedBy, created_at as createdAt";

export function requestApproval(
  db: Database.Database,
  params: { room: string; agent: string; action: string; reason?: string; tier?: ApprovalTier }
): { status: "allowed" | "pending" | "denied"; id: number } {
  const tier: ApprovalTier = params.tier === "lead" ? "lead" : "human";
  return db.transaction(() => {
    const previous = db
      .prepare(`SELECT ${COLUMNS} FROM approvals WHERE room = ? AND agent = ? AND action = ? AND status != 'used' ORDER BY id DESC LIMIT 1`)
      .get(params.room, params.agent, params.action) as Approval | undefined;
    // The tier comes from the gate on every retry, so an agent's approval of an
    // action the gate now calls the human's does not count, however it was filed.
    const counts = previous?.decidedBy === "human" || tier === "lead";
    if (previous?.status === "allowed" && counts) {
      db.prepare("UPDATE approvals SET status = 'used' WHERE id = ?").run(previous.id);
      return { status: "allowed" as const, id: previous.id };
    }
    if (previous?.status === "denied") return { status: "denied" as const, id: previous.id };
    if (previous?.status === "pending" && previous.tier === tier) return { status: "pending" as const, id: previous.id };
    if (previous) db.prepare("UPDATE approvals SET status = 'used' WHERE id = ?").run(previous.id);

    const id = Number(
      db.prepare("INSERT INTO approvals (room, agent, action, reason, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(params.room, params.agent, params.action, params.reason ?? null, tier, Date.now()).lastInsertRowid
    );
    const lead = [...roomLeads(db, params.room)].find((name) => name !== params.agent);
    const what = `${params.action}${params.reason ? ` (${params.reason})` : ""}`;
    roomSend(db, {
      room: params.room,
      agent: params.agent,
      origin: "system",
      ...(tier === "lead" && lead
        ? {
            to: [lead],
            message:
              `${params.agent} asks #${id}: ${what}. ${lead}, as the lead you may answer it with room_allow ` +
              `{room, agent: "${lead}", id: ${id}, allow, reason}: allow what is routine for the task, deny anything ` +
              `you would not do yourself, and leave it to the human when unsure.`,
          }
        : {
            to: lead ? ["human", lead] : ["human"],
            message:
              `${params.agent} needs your approval #${id}: ${what}. /allow ${id} or /deny ${id}` +
              (lead ? ` — ${lead}: tell the human in a line whether you would approve it.` : ""),
          }),
    });
    return { status: "pending" as const, id };
  })();
}

export function pendingApprovals(db: Database.Database, room: string): Approval[] {
  return db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE room = ? AND status = 'pending' ORDER BY id`).all(room) as Approval[];
}

/**
 * An answer. The human answers anything open; the lead only `lead` requests,
 * never its own, and only while it is the lead. A denied request can still be
 * allowed later; a used one is done.
 */
export function decideApproval(
  db: Database.Database,
  room: string,
  id: number,
  allow: boolean,
  by = "human",
  note?: string
): { ok: true; approval: Approval } | { ok: false; error: string } {
  const approval = db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ? AND room = ?`).get(id, room) as Approval | undefined;
  if (!approval || !["pending", "denied"].includes(approval.status)) return { ok: false, error: `no open request #${id} in this room` };
  if (by !== "human") {
    if (!roomLeads(db, room).has(by)) return { ok: false, error: `only the human or the room's lead answers requests; ${by} is not the lead` };
    if (approval.agent === by) return { ok: false, error: `#${id} is your own request; the human answers it` };
    if (approval.tier === "human") return { ok: false, error: `#${id} touches production, secrets or something that cannot be undone; only the human answers it` };
  }
  db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(allow ? "allowed" : "denied", by, Date.now(), id);
  const who = by === "human" ? "" : ` by ${by}`;
  roomSend(db, {
    room,
    agent: by,
    origin: by === "human" ? "human" : "agent",
    to: [approval.agent],
    message: (allow
      ? `Approved #${id}${who}: ${approval.action}. Run it again now; it is allowed once.`
      : `Denied #${id}${who}: ${approval.action}. Do not run it; find another way or ask the human.`) + (note ? ` ${note}` : ""),
  });
  return { ok: true, approval: { ...approval, status: allow ? "allowed" : "denied", decidedBy: by } };
}
