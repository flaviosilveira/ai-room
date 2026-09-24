import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { addAgent, nextInstanceName, removeAgent } from "../src/cast.js";
import { roomCharter, roomHistory, roomJoin, roomSetCharter, roomWho, setWakeTarget } from "../src/store.js";
import { detectMultiplexer, ensureWorkspace, killWorkspace, paneStates, workspaceName } from "../src/session.js";

const tmux = detectMultiplexer("tmux");

describe("changing the cast of a running room", () => {
  const room = `vitest-cast-${process.pid}`;
  const session = workspaceName(room);
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room, agent: "human" });
    roomSetCharter(db, {
      room,
      roster: [
        { agent: "claude", harness: "claude" },
        { agent: "codex", harness: "codex", role: "reviewer" },
      ],
    });
    roomJoin(db, { room, agent: "codex" });
    setWakeTarget(db, { room, agent: "codex", wake: { kind: "codex-queue", id: "11111111-2222-4333-8444-555555555555" } });
  });

  afterEach(() => {
    if (tmux) killWorkspace(tmux, session);
    db.close();
  });

  it("removes one agent for good and tells the rest", () => {
    const result = removeAgent(db, room, "codex");
    expect(result.ok).toBe(true);
    expect(roomCharter(db, room)!.roster.map((e) => e.agent)).toEqual(["claude"]);
    expect(roomWho(db, { room }).find((p) => p.agent === "codex")).toMatchObject({ active: false, wake: null });
    expect(roomHistory(db, { room }).at(-1)!.content).toMatch(/codex left the room/);
  });

  it("hands the lead to the next agent by preference when the lead leaves", () => {
    roomSetCharter(db, {
      room,
      roster: [
        { agent: "claude", harness: "claude", role: "lead, implementer" },
        { agent: "codex", harness: "codex", role: "reviewer" },
        { agent: "agy", harness: "agy" },
      ],
    });
    removeAgent(db, room, "claude");
    const roster = roomCharter(db, room)!.roster;
    expect(roster.find((e) => e.agent === "agy")!.role).toBe("lead");
    expect(roster.find((e) => e.agent === "codex")!.role).toBe("reviewer");
    expect(roomHistory(db, { room }).at(-1)!.content).toMatch(/agy is now the lead/);
  });

  it("refuses what is not an agent", () => {
    expect(removeAgent(db, room, "monitor").ok).toBe(false);
    expect(removeAgent(db, "no-such-room", "codex").ok).toBe(false);
  });

  it.skipIf(!tmux)("closes only that agent's pane", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [
      { title: "claude", command: ["sleep", "60"] },
      { title: "codex", command: ["sleep", "60"] },
    ]);
    removeAgent(db, room, "codex");
    expect(paneStates(tmux!, session).map((p) => p.agent)).toEqual(["claude"]);
  });

  it("numbers another instance, never reusing a name that ever joined", () => {
    expect(nextInstanceName(new Set(["claude"]), "codex")).toBe("codex");
    expect(nextInstanceName(new Set(["codex", "codex-2"]), "codex")).toBe("codex-3");
    expect(nextInstanceName(new Set(["codex", "codex-2"]), "codex-2")).toBe("codex-3");
  });

  it("asks before adding another instance of an agent already in the room", () => {
    const asked = addAgent(db, room, "codex");
    expect(asked).toMatchObject({ ok: false, confirm: "codex-2" });
    expect(roomCharter(db, room)!.roster.map((e) => e.agent)).toEqual(["claude", "codex"]);

    const added = addAgent(db, room, "codex", undefined, { confirmed: true });
    expect(added).toMatchObject({ ok: true, agent: "codex-2" });
    expect(roomCharter(db, room)!.roster.map((e) => e.agent)).toContain("codex-2");
  });

  it("brings a removed agent back without asking", () => {
    removeAgent(db, room, "codex");
    expect(addAgent(db, room, "codex")).toMatchObject({ ok: true, agent: "codex" });
  });

  it("adds an agent back to the roster, keeping its role", () => {
    removeAgent(db, room, "codex");
    expect(addAgent(db, room, "codex-2", "researcher").ok).toBe(true);
    expect(roomCharter(db, room)!.roster).toContainEqual(expect.objectContaining({ agent: "codex-2", harness: "codex", role: "researcher" }));
    expect(addAgent(db, room, "nope").ok).toBe(false);
  });
});
