import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { decideKnowledge, ignoreReportsInGit, knowledgeMirrorDir, knowledgeProjects, knowledgeSections, pendingKnowledge, proposeKnowledge, readKnowledge, removeRoomReports, roomReportsDir, syncRoomLinks, writeRoomSummary } from "../src/knowledge.js";
import { roomHistory, roomJoin, roomSetCharter } from "../src/store.js";

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

  it("links a room's reports into the vault once there are any, and drops the link with them", () => {
    const project = path.join(dir, "project");
    roomSetCharter(db, { room: "r", cwd: project });
    const vault = knowledgeMirrorDir(db)!;
    const link = path.join(vault, "rooms", "r");
    syncRoomLinks(db);
    expect(fs.existsSync(link)).toBe(false);

    fs.mkdirSync(roomReportsDir(project, "r"), { recursive: true });
    fs.writeFileSync(path.join(roomReportsDir(project, "r"), "report.md"), "# Report");
    syncRoomLinks(db);
    expect(fs.readFileSync(path.join(link, "report.md"), "utf8")).toBe("# Report");

    removeRoomReports(project, "r", vault);
    expect(fs.existsSync(roomReportsDir(project, "r"))).toBe(false);
    expect(fs.existsSync(link)).toBe(false);
    expect(() => readKnowledge(db, "r", "human", "rooms")).toThrow(/taken/);
  });

  it("keeps a Markdown copy of each base beside it, rewritten on every approval", () => {
    readKnowledge(db, "r", "human", "acme");
    const approve = (section: string, body: string) =>
      decideKnowledge(db, proposeKnowledge(db, { room: "r", agent: "codex", section, body }).id, true);
    approve("Deploy / CI", "## How\nMain deploys through the pipeline.");
    approve("Tenants e negócio", "Each tenant is a school.");
    const base = path.join(dir, "kb", "acme");
    expect(fs.readdirSync(base).sort()).toEqual(["Deploy - CI.md", "Tenants e negócio.md", "index.md"]);
    expect(fs.readFileSync(path.join(base, "Deploy - CI.md"), "utf8")).toMatch(/^# Deploy \/ CI\n\n## How\nMain deploys/);
    expect(fs.readFileSync(path.join(base, "index.md"), "utf8")).toContain("- [Tenants e negócio](Tenants%20e%20neg%C3%B3cio.md): Each tenant is a school.");

    fs.writeFileSync(path.join(base, "Old name.md"), "stale");
    approve("Deploy / CI", "Deploys by tag.");
    expect(fs.existsSync(path.join(base, "Old name.md"))).toBe(false);
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
    expect(readKnowledge(db, "r", "codex").index).toMatchObject([{ section: "Deploy", summary: "Main deploys through the pipeline." }]);
    expect(readKnowledge(db, "r", "codex", undefined, { section: "deploy" }).section?.body).toBe("Main deploys through the pipeline.");
    expect(readKnowledge(db, "r", "codex", undefined, { query: "PIPELINE" }).index).toHaveLength(1);
    expect(readKnowledge(db, "r", "codex", undefined, { query: "kubernetes" }).index).toEqual([]);
    expect(readKnowledge(db, "r", "codex", undefined, { section: "Billing" })).toMatchObject({ index: [{ section: "Deploy" }] });
  });

  it("writes the room's summary where the human reads the reports", () => {
    const project = path.join(dir, "project");
    writeRoomSummary(project, "r", "## State\nTests next.");
    expect(fs.readFileSync(path.join(roomReportsDir(project, "r"), "summary.md"), "utf8")).toBe("# r\n\n## State\nTests next.\n");
    writeRoomSummary(null, "r", "nowhere");
  });

  it("keeps the reports out of git once, without touching a versioned file", () => {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    ignoreReportsInGit(repo);
    ignoreReportsInGit(repo);
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === ".ai-room/")).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
    ignoreReportsInGit(dir);
  });
});
