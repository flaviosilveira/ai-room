import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomBriefing, roomCharter, roomJoin, roomSetCharter } from "../src/store.js";
import { LAUNCHERS, invite, joinPrompt } from "../src/invite.js";

describe("room charter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomSetCharter(db, {
      room: "r",
      brief: "Refactor auth.",
      conventionPreset: "caveman",
      tools: ["graphify"],
      roster: [
        { agent: "codex", role: "reviewer" },
        { agent: "agy", role: "validator", instructions: "Check the migration." },
      ],
    });
  });

  afterEach(() => db.close());

  it("expands a convention preset and a tool preset by name", () => {
    const charter = roomCharter(db, "r")!;
    expect(charter.conventionPreset).toBe("caveman");
    expect(charter.conventions).toMatch(/terse/i);
    expect(charter.tools[0]).toMatchObject({ name: "graphify" });
    expect(charter.tools[0].howToUse).toMatch(/graphify/);
  });

  it("rejects an unknown convention preset instead of silently storing it", () => {
    expect(() => roomSetCharter(db, { room: "r", conventionPreset: "nope" })).toThrow(
      /Unknown convention preset/
    );
  });

  it("gives each agent its own role and the teammates it should expect", () => {
    const codex = roomBriefing(db, "r", "codex")!;
    expect(codex.you).toMatchObject({ agent: "codex", role: "reviewer" });
    expect(codex.teammates.map((t) => t.agent)).toEqual(["agy"]);

    const agy = roomBriefing(db, "r", "agy")!;
    expect(agy.you).toMatchObject({ role: "validator", instructions: "Check the migration." });
    expect(agy.teammates.map((t) => t.agent)).toEqual(["codex"]);
  });

  it("briefs an agent that is not on the roster, with no role", () => {
    const stranger = roomBriefing(db, "r", "someone-else")!;
    expect(stranger.you).toBeNull();
    expect(stranger.brief).toBe("Refactor auth.");
    expect(stranger.teammates.map((t) => t.agent)).toEqual(["codex", "agy"]);
  });

  it("delivers the briefing through room_join", () => {
    const result = roomJoin(db, { room: "r", agent: "codex" });
    expect(result.briefing?.you).toMatchObject({ role: "reviewer" });
  });

  it("returns no briefing for a room that has no charter", () => {
    roomJoin(db, { room: "bare", agent: "claude" });
    expect(roomCharter(db, "bare")).toBeNull();
    expect(roomJoin(db, { room: "bare", agent: "codex" }).briefing).toBeNull();
  });

  it("leaves untouched fields alone on partial update", () => {
    roomSetCharter(db, { room: "r", brief: "New brief." });
    const charter = roomCharter(db, "r")!;
    expect(charter.brief).toBe("New brief.");
    expect(charter.conventionPreset).toBe("caveman");
    expect(charter.roster).toHaveLength(2);
  });

  it("refuses a charter for a room that does not exist", () => {
    expect(() => roomSetCharter(db, { room: "ghost", brief: "x" })).toThrow(/does not exist/);
  });
});

describe("invite launcher", () => {
  it("builds a seed prompt naming the room, the agent and the wait loop", () => {
    const prompt = joinPrompt("refactor-auth", "codex");
    expect(prompt).toContain('"refactor-auth"');
    expect(prompt).toContain('"codex"');
    expect(prompt).toMatch(/room_join/);
    expect(prompt).toMatch(/room_wait/);
    expect(prompt).toMatch(/briefing/);
  });

  it("knows a launcher for each supported harness", () => {
    expect(Object.keys(LAUNCHERS).sort()).toEqual(["agy", "claude", "codex"]);
    expect(LAUNCHERS.codex.args("P")).toEqual(["exec", "--skip-git-repo-check", "P"]);
    expect(LAUNCHERS.claude.args("P")).toEqual(["-p", "P"]);
  });

  it("reports the command without spawning anything on a dry run", () => {
    const result = invite("r", "codex", { dryRun: true });
    expect(result.status).toBe("launched");
    expect(result.pid).toBeUndefined();
    expect(result.command).toContain("codex exec");
  });

  it("fails cleanly for an unknown harness", () => {
    const result = invite("r", "nonexistent-agent", {});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/No launcher/);
  });
});
