import type Database from "better-sqlite3";
import { roomCharter, roomLeads, roomSend, roomSetCharter } from "./store.js";

/**
 * A knowledge base per company or project: the business, its rules, how it
 * deploys, its stack. Every room bound to it starts from what is there, and
 * what a task learns comes back as a proposal the human approves, so the base
 * grows without filling up with guesses. It lives in the attached `kb` schema.
 */
export interface KnowledgeSection {
  section: string;
  body: string;
  updatedBy: string | null;
  updatedAt: number;
}

export interface KnowledgeProposal {
  id: number;
  project: string;
  section: string;
  body: string;
  reason: string | null;
  proposedBy: string;
  room: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

const PROPOSAL = "id, project, section, body, reason, proposed_by as proposedBy, room, status, created_at as createdAt";
const NAME = /^[\w.-]{1,60}$/;

export function knowledgeProjects(db: Database.Database): { project: string; sections: number; updatedAt: number }[] {
  return db
    .prepare("SELECT project, COUNT(*) as sections, MAX(updated_at) as updatedAt FROM kb.sections GROUP BY project ORDER BY project")
    .all() as { project: string; sections: number; updatedAt: number }[];
}

export function knowledgeSections(db: Database.Database, project: string): KnowledgeSection[] {
  return db
    .prepare("SELECT section, body, updated_by as updatedBy, updated_at as updatedAt FROM kb.sections WHERE project = ? ORDER BY section")
    .all(project) as KnowledgeSection[];
}

/**
 * What room_knowledge answers: the room's base, or, when it has none yet, the
 * bases there are so the lead can ask the human which one this room belongs to.
 * Naming one binds the room to it; only the lead or the human may.
 */
export function readKnowledge(
  db: Database.Database,
  room: string,
  agent: string,
  bind?: string | null
): { project: string | null; sections: KnowledgeSection[]; projects: string[]; note?: string } {
  if (bind !== undefined) {
    if (agent !== "human" && !roomLeads(db, room).has(agent)) throw new Error("only the lead or the human chooses the room's knowledge base");
    if (bind !== null && !NAME.test(bind)) throw new Error("a base is named with letters, digits, dot, dash or underscore");
    roomSetCharter(db, { room, knowledge: bind });
  }
  const project = roomCharter(db, room)?.knowledge ?? null;
  const projects = knowledgeProjects(db).map((p) => p.project);
  if (!project) {
    return {
      project,
      sections: [],
      projects,
      note:
        "This room has no knowledge base. Ask the human once which company or project it belongs to" +
        (projects.length ? ` (existing: ${projects.join(", ")})` : "") +
        ", a new name, or none; then call room_knowledge with that project.",
    };
  }
  return { project, sections: knowledgeSections(db, project), projects };
}

export function proposeKnowledge(
  db: Database.Database,
  params: { room: string; agent: string; section: string; body: string; reason?: string }
): KnowledgeProposal {
  const project = roomCharter(db, params.room)?.knowledge;
  if (!project) throw new Error("this room has no knowledge base; choose one with room_knowledge first");
  const section = params.section.trim().slice(0, 80);
  if (!section) throw new Error("a section name is required");
  const id = Number(
    db
      .prepare("INSERT INTO kb.proposals (project, section, body, reason, proposed_by, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(project, section, params.body, params.reason ?? null, params.agent, params.room, Date.now()).lastInsertRowid
  );
  roomSend(db, {
    room: params.room,
    agent: params.agent,
    origin: "system",
    to: ["human"],
    message: `${params.agent} proposes a knowledge update #k${id} to "${project}" › ${section}${params.reason ? ` (${params.reason})` : ""}. /kb ${id} to read it, /kb approve ${id} or /kb reject ${id}`,
  });
  return db.prepare(`SELECT ${PROPOSAL} FROM kb.proposals WHERE id = ?`).get(id) as KnowledgeProposal;
}

export function pendingKnowledge(db: Database.Database, project: string): KnowledgeProposal[] {
  return db.prepare(`SELECT ${PROPOSAL} FROM kb.proposals WHERE project = ? AND status = 'pending' ORDER BY id`).all(project) as KnowledgeProposal[];
}

export function knowledgeProposal(db: Database.Database, id: number): KnowledgeProposal | null {
  return (db.prepare(`SELECT ${PROPOSAL} FROM kb.proposals WHERE id = ?`).get(id) as KnowledgeProposal | undefined) ?? null;
}

/** Only the human decides: an approved proposal replaces its section, a new one adds it. */
export function decideKnowledge(db: Database.Database, id: number, approve: boolean): KnowledgeProposal | null {
  const proposal = knowledgeProposal(db, id);
  if (!proposal || proposal.status !== "pending") return null;
  const now = Date.now();
  db.transaction(() => {
    db.prepare("UPDATE kb.proposals SET status = ?, decided_at = ? WHERE id = ?").run(approve ? "approved" : "rejected", now, id);
    if (approve) {
      db.prepare(
        `INSERT INTO kb.sections (project, section, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project, section) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(proposal.project, proposal.section, proposal.body, proposal.proposedBy, now);
    }
  })();
  if (proposal.room) {
    roomSend(db, {
      room: proposal.room,
      agent: "human",
      origin: "human",
      to: [proposal.proposedBy],
      message: approve
        ? `Knowledge update #k${id} approved: "${proposal.project}" › ${proposal.section} now reads as proposed.`
        : `Knowledge update #k${id} rejected; "${proposal.project}" › ${proposal.section} stays as it was.`,
    });
  }
  return { ...proposal, status: approve ? "approved" : "rejected" };
}
