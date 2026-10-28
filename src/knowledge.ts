import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { knowledgePath } from "./db/index.js";
import { roomCharter, roomLeads, roomList, roomSend, roomSetCharter } from "./store.js";

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

/** One line of the index: enough to pick the section worth reading. */
export interface KnowledgeEntry {
  section: string;
  summary: string;
  chars: number;
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

/** The first line of prose, so the index says what a section is about. */
function summaryOf(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const prose = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
  const line = prose.replace(/^[>*\-\s]+/, "").replace(/\*\*/g, "").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function knowledgeIndex(db: Database.Database, project: string, query?: string): KnowledgeEntry[] {
  const needle = query?.trim().toLowerCase();
  return knowledgeSections(db, project)
    .filter((s) => !needle || s.section.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle))
    .map((s) => ({ section: s.section, summary: summaryOf(s.body), chars: s.body.length, updatedAt: s.updatedAt }));
}

/**
 * What room_knowledge answers: the index of the room's base, one section when
 * named, or the sections that mention `query`. Reading the index first keeps a
 * growing base from costing every agent all of it on every join. A room with
 * no base lists the bases there are, so the lead can ask the human which one
 * this room belongs to. Naming one binds the room to it; only the lead or the
 * human may.
 */
export function readKnowledge(
  db: Database.Database,
  room: string,
  agent: string,
  bind?: string | null,
  read: { section?: string; query?: string } = {}
): {
  project: string | null;
  index?: KnowledgeEntry[];
  section?: KnowledgeSection;
  projects: string[];
  note?: string;
} {
  if (bind !== undefined) {
    if (agent !== "human" && !roomLeads(db, room).has(agent)) throw new Error("only the lead or the human chooses the room's knowledge base");
    if (bind !== null && !NAME.test(bind)) throw new Error("a base is named with letters, digits, dot, dash or underscore");
    if (bind === ROOMS_DIR) throw new Error(`"${ROOMS_DIR}" is taken by the rooms' reports; choose another name`);
    roomSetCharter(db, { room, knowledge: bind });
  }
  const project = roomCharter(db, room)?.knowledge ?? null;
  const projects = knowledgeProjects(db).map((p) => p.project);
  if (!project) {
    return {
      project,
      projects,
      note:
        "This room has no knowledge base yet. When you find something worth keeping, ask the human whether it goes in" +
        (projects.length ? ` one of these (${projects.join(", ")}),` : "") +
        " a new base you suggest a name for, or nowhere; then call room_knowledge with that project.",
    };
  }
  if (read.section) {
    const wanted = read.section.trim().toLowerCase();
    const found = knowledgeSections(db, project).find((s) => s.section.toLowerCase() === wanted);
    if (found) return { project, section: found, projects };
    return { project, index: knowledgeIndex(db, project), projects, note: `No section "${read.section}"; the index lists the ones there are.` };
  }
  const index = knowledgeIndex(db, project, read.query);
  return {
    project,
    index,
    projects,
    note: read.query
      ? `${index.length} section(s) mention "${read.query}". Read one with room_knowledge({ section }).`
      : "This is the index. Read the sections your task touches with room_knowledge({ section }), or find one with { query }.",
  };
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
  if (approve) mirrorKnowledge(db, proposal.project);
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

/** The vault folder that holds a link to each room's reports, beside the bases. */
export const ROOMS_DIR = "rooms";

const unsafe = /[\\/:*?"<>|\x00-\x1f]/g;
const fileName = (section: string) => `${section.replace(unsafe, "-").trim() || "section"}.md`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Where the Markdown copy lives: beside knowledge.sqlite, or nowhere for an in-memory database. */
export function knowledgeMirrorDir(db: Database.Database): string | null {
  return db.name === ":memory:" ? null : path.join(path.dirname(knowledgePath(db.name)), "kb");
}

/**
 * A read-only Markdown copy of a base, for the human to read and study in any
 * editor or an Obsidian vault: an index plus one file per section, rewritten
 * whole on every approval so a renamed section leaves nothing stale behind.
 * The database stays the source; an edit made in the copy is overwritten.
 */
export function mirrorKnowledge(db: Database.Database, project: string, root = knowledgeMirrorDir(db)): void {
  if (!root || !NAME.test(project) || project === ROOMS_DIR) return;
  try {
    const dir = path.join(root, project);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) if (file.endsWith(".md")) fs.rmSync(path.join(dir, file));
    const sections = knowledgeSections(db, project);
    for (const s of sections) {
      fs.writeFileSync(path.join(dir, fileName(s.section)), `# ${s.section}\n\n${s.body.trim()}\n\n---\n_${s.updatedBy ?? "unknown"}, ${day(s.updatedAt)}_\n`);
    }
    const index = [
      `# ${project}`,
      "",
      "> A copy of the ai-room knowledge base, rewritten on every approved update. Edits here are overwritten:",
      "> change a section by proposing it in a room (`room_knowledge_propose`) and approving it with `/kb approve`.",
      "",
      ...sections.map((s) => `- [${s.section}](${encodeURI(fileName(s.section))}): ${summaryOf(s.body)}`),
      "",
    ];
    fs.writeFileSync(path.join(dir, "index.md"), index.join("\n"));
  } catch {
    // The copy is a convenience; a failure to write it never blocks an approval.
  }
}

/** Brings every base's copy up to date, for a server that starts with bases approved elsewhere. */
export function mirrorAllKnowledge(db: Database.Database, root = knowledgeMirrorDir(db)): void {
  for (const { project } of knowledgeProjects(db)) mirrorKnowledge(db, project, root);
}

/**
 * Where a room's lead writes what is for the human to read: inside the project,
 * where every agent may write without asking, one folder per room.
 */
export function roomReportsDir(cwd: string, room: string): string {
  return path.join(cwd, ".ai-room", "for-human", room.replace(unsafe, "-"));
}

/** The room's summary, as the human reads it in the vault beside the reports. */
export function writeRoomSummary(cwd: string | null | undefined, room: string, summary: string): void {
  if (!cwd) return;
  try {
    const dir = roomReportsDir(cwd, room);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.md"), `# ${room}\n\n${summary}\n`);
  } catch {
    /* agents still read it from the room */
  }
}

/** Keeps the reports out of git without touching a file the project versions. */
export function ignoreReportsInGit(cwd: string): void {
  const found = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8" });
  if (found.status !== 0 || !found.stdout.trim()) return;
  const exclude = path.resolve(cwd, found.stdout.trim());
  try {
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === ".ai-room/")) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.ai-room/\n`);
  } catch {
    /* an unignored report shows in git status; nothing is lost */
  }
}

/**
 * Links each room's reports into the vault, beside the bases, so the editor the
 * human keeps on ~/.ai-room/kb already shows them. A link appears once the room
 * has written something and goes once its folder or the room is gone. Nothing
 * is copied: the files stay in the project and are temporary.
 */
export function syncRoomLinks(db: Database.Database, root = knowledgeMirrorDir(db)): void {
  if (!root) return;
  const dir = path.join(root, ROOMS_DIR);
  const wanted = new Map<string, string>();
  for (const { name } of roomList(db, { limit: -1 })) {
    const cwd = roomCharter(db, name)?.cwd;
    if (!cwd) continue;
    const target = roomReportsDir(cwd, name);
    if (fs.existsSync(target)) wanted.set(path.basename(target), target);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const link = path.join(dir, entry.name);
      if (!entry.isSymbolicLink()) continue;
      if (wanted.get(entry.name) === fs.readlinkSync(link)) wanted.delete(entry.name);
      else fs.rmSync(link);
    }
    for (const [name, target] of wanted) fs.symlinkSync(target, path.join(dir, name), "dir");
  } catch {
    // The links are a convenience; the reports are still in the project.
  }
}

/** A deleted room takes its reports and their link with it. */
export function removeRoomReports(cwd: string | null | undefined, room: string, root: string | null): void {
  try {
    if (cwd) fs.rmSync(roomReportsDir(cwd, room), { recursive: true, force: true });
    if (root) fs.rmSync(path.join(root, ROOMS_DIR, path.basename(roomReportsDir("/", room))), { force: true });
  } catch {
    /* nothing left to remove */
  }
}
