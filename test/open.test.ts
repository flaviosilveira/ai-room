import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomCharter, roomJoin, roomSetCharter } from "../src/store.js";
import { agentsToLaunch, charterPatch, parseOpenFlags } from "../src/open.js";
import { DRIVERS_FOR_TEST, attachArgv, canAttach, insideMultiplexer } from "../src/session.js";

describe("reopening a room", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
  });
  afterEach(() => db.close());

  it("keeps the charter when reopened with no flags", () => {
    roomSetCharter(db, charterPatch("r", parseOpenFlags(
      ["--brief", "Fix auth.", "--convention", "caveman", "--tool", "graphify", "--invite", "claude,codex", "--role", "codex=reviewer"]
    )));

    // `ai-room open r` — the reattach path. It used to send every field, which
    // wiped the brief, the tooling and the roster of the room being reopened.
    roomSetCharter(db, charterPatch("r", parseOpenFlags([])));

    const charter = roomCharter(db, "r")!;
    expect(charter.brief).toBe("Fix auth.");
    expect(charter.conventionPreset).toBe("caveman");
    expect(charter.tools.map((t) => t.name)).toEqual(["graphify"]);
    expect(charter.roster).toEqual([
      { agent: "claude", harness: "claude" },
      { agent: "codex", harness: "codex", role: "reviewer" },
    ]);
  });

  it("only writes the fields that were given", () => {
    expect(charterPatch("r", parseOpenFlags([]))).toEqual({ room: "r" });
    expect(charterPatch("r", parseOpenFlags(["--invite", "claude-2"])).roster).toEqual([
      { agent: "claude-2", harness: "claude", role: undefined },
    ]);
    expect(charterPatch("r", parseOpenFlags(["--brief", ""]))).toEqual({ room: "r", brief: "" });
  });

  it("relaunches the charter's cast when --invite is omitted", () => {
    const roster = [{ agent: "claude" }, { agent: "codex", role: "reviewer" }];
    expect(agentsToLaunch(parseOpenFlags([]), roster)).toEqual(["claude", "codex"]);
    // An explicit invite still wins.
    expect(agentsToLaunch(parseOpenFlags(["--invite", "agy"]), roster)).toEqual(["agy"]);
  });

  it("never tries to launch the human as a harness", () => {
    const roster = [{ agent: "human", role: "host" }, { agent: "claude" }];
    expect(agentsToLaunch(parseOpenFlags([]), roster)).toEqual(["claude"]);
  });
});

describe("attaching", () => {
  const tmux = DRIVERS_FOR_TEST.tmux;

  it("attaches from outside and switches from inside", () => {
    // `tmux attach` from within tmux refuses to nest; switch-client is the
    // in-session equivalent, so `open` works from a pane too.
    expect(attachArgv(tmux, "s")).toEqual(["attach-session", "-t", "s"]);
    expect(attachArgv(tmux, "s", { insideMultiplexer: true })).toEqual(["switch-client", "-t", "s"]);
  });

  it("reattaches screen sessions too", () => {
    expect(attachArgv(DRIVERS_FOR_TEST.screen, "s")).toEqual(["-r", "s"]);
  });

  it("detects both multiplexers from the environment", () => {
    expect(insideMultiplexer({})).toBe(false);
    expect(insideMultiplexer({ TMUX: "/tmp/tmux-501/default,1,0" })).toBe(true);
    expect(insideMultiplexer({ STY: "123.pts-0.host" })).toBe(true);
  });

  it("refuses to attach without a terminal on both ends", () => {
    expect(canAttach({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(canAttach({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(canAttach({ isTTY: true }, { isTTY: undefined })).toBe(false);
  });
});

describe("join hand-off", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("tells a briefed agent to start working, not to wait", () => {
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomSetCharter(db, { room: "r", brief: "Fix auth.", roster: [{ agent: "codex", role: "reviewer" }] });

    // The first real session stayed silent until a human said "can you start?":
    // every instruction the agent had ended in room_wait.
    const joined = roomJoin(db, { room: "r", agent: "codex" });
    expect(joined.nextAction).toMatch(/start now/i);
    expect(joined.nextAction).toMatch(/room_wait only/i);
  });

  it("asks what the room is for when there is no charter", () => {
    const joined = roomJoin(db, { room: "bare", agent: "codex" });
    expect(joined.briefing).toBeNull();
    expect(joined.nextAction).toMatch(/no charter/i);
  });
});
