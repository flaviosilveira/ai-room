import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { decideKnowledge, knowledgeProjects, knowledgeSections, pendingKnowledge, proposeKnowledge, readKnowledge } from "../src/knowledge.js";
import { roomHistory, roomJoin } from "../src/store.js";

describe("knowledge base", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-kb-"));
    db = openDb(path.join(dir, "ai-room.sqlite"));
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomJoin(db, { room: "r", agent: "claude", role: "lead" });
    roomJoin(db, { room: "r", agent: "codex" });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the bases in a file of their own", () => {
    expect(fs.existsSync(path.join(dir, "knowledge.sqlite"))).toBe(true);
  });

  it("tells a room with no base to ask the human, and lets only the lead or the human choose", () => {
    const first = readKnowledge(db, "r", "claude");
    expect(first.project).toBeNull();
    expect(first.note).toMatch(/ask the human whether it goes in/);
    expect(() => readKnowledge(db, "r", "codex", "acme")).toThrow(/only the lead or the human/);
    expect(() => readKnowledge(db, "r", "claude", "../x")).toThrow(/letters, digits/);
    expect(readKnowledge(db, "r", "claude", "acme").project).toBe("acme");
  });

  it("grows only through proposals the human approves", () => {
    expect(() => proposeKnowledge(db, { room: "r", agent: "codex", section: "Deploy", body: "x" })).toThrow(/no knowledge base/);
    readKnowledge(db, "r", "human", "acme");

    const deploy = proposeKnowledge(db, { room: "r", agent: "codex", section: "Deploy", body: "Main deploys through the pipeline.", reason: "seen in the task" });
    expect(roomHistory(db, { room: "r" }).at(-1)).toMatchObject({ origin: "system", to: ["human"] });
    expect(knowledgeSections(db, "acme")).toEqual([]);
    expect(pendingKnowledge(db, "acme").map((p) => p.id)).toEqual([deploy.id]);

    decideKnowledge(db, deploy.id, true);
    expect(knowledgeSections(db, "acme")).toMatchObject([{ section: "Deploy", body: "Main deploys through the pipeline.", updatedBy: "codex" }]);
    expect(decideKnowledge(db, deploy.id, true)).toBeNull();

    const wrong = proposeKnowledge(db, { room: "r", agent: "claude", section: "Deploy", body: "Deploys by hand." });
    decideKnowledge(db, wrong.id, false);
    expect(knowledgeSections(db, "acme")[0].body).toBe("Main deploys through the pipeline.");
    expect(knowledgeProjects(db)).toMatchObject([{ project: "acme", sections: 1 }]);
    expect(readKnowledge(db, "r", "codex").sections).toHaveLength(1);
  });
});
