import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomCharter, roomJoin, roomSetCharter } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsToLaunch, charterPatch, loadOpenDefaults, parseOpenFlags, pickLead, withDefaults } from "../src/open.js";
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

describe("machine defaults for new rooms", () => {
  const defaults = { tools: ["rtk", "graphify"], convention: "caveman,ponytail", invite: ["claude", "codex"] };

  it("fill what a new room was not given", () => {
    const flags = withDefaults(parseOpenFlags(["--brief", "x"]), defaults, true);
    expect(flags.tools).toEqual(["rtk", "graphify"]);
    // Two agents invited: one becomes the lead, and its convention comes along.
    expect(flags.convention).toBe("caveman,ponytail,lead");
    expect(flags.invite).toEqual(["claude", "codex"]);
  });

  it("never override what was passed", () => {
    const flags = withDefaults(parseOpenFlags(["--tool", "grill-me", "--convention", "concise"]), defaults, true);
    expect(flags.tools).toEqual(["grill-me"]);
    expect(flags.convention).toBe("concise,lead");
  });

  it("leave an existing room's charter alone, and yield to --no-defaults", () => {
    expect(withDefaults(parseOpenFlags([]), defaults, false).tools).toEqual([]);
    expect(withDefaults(parseOpenFlags(["--no-defaults"]), defaults, true).convention).toBeUndefined();
  });

  it("turns the mouse on unless the flag or the config says off", () => {
    expect(withDefaults(parseOpenFlags([]), {}, true).mouse).toBe(true);
    expect(withDefaults(parseOpenFlags([]), {}, false).mouse).toBe(true);
    expect(withDefaults(parseOpenFlags(["--no-mouse"]), {}, true).mouse).toBe(false);
    expect(withDefaults(parseOpenFlags([]), { mouse: false }, false).mouse).toBe(false);
    expect(withDefaults(parseOpenFlags(["--mouse"]), { mouse: false }, true).mouse).toBe(true);
    expect(withDefaults(parseOpenFlags(["--no-defaults"]), { mouse: false }, true).mouse).toBe(true);
  });

  it("reads the config file and survives a broken one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ defaults: { tools: ["rtk", 3], convention: "caveman" } }));
      expect(loadOpenDefaults(file)).toEqual({ tools: ["rtk"], convention: "caveman", invite: undefined });
      fs.writeFileSync(file, "{nope");
      expect(loadOpenDefaults(file)).toEqual({});
      expect(loadOpenDefaults(path.join(dir, "missing.json"))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the lead: one agent talks to the human", () => {
  const open = (argv: string[], defaults = {}) => withDefaults(parseOpenFlags(argv), defaults, true);

  it("prefers claude, then agy, and codex only when alone", () => {
    expect(pickLead(["codex", "agy", "claude-2"])).toBe("claude-2");
    expect(pickLead(["codex", "agy"])).toBe("agy");
    expect(pickLead(["codex", "codex-2"])).toBe("codex");
    expect(pickLead(["codex", "claude"], ["codex", "claude"])).toBe("codex");
  });

  it("picks one on its own and adds the convention that says how", () => {
    const flags = open(["--invite", "codex,claude,agy", "--convention", "caveman"]);
    expect(flags.roles.get("claude")).toBe("lead");
    expect(flags.convention).toBe("caveman,lead");
  });

  it("keeps the role an agent was given", () => {
    expect(open(["--invite", "claude,codex", "--role", "claude=implementer"]).roles.get("claude")).toBe("lead, implementer");
  });

  it("follows --lead, an explicit lead role, --no-lead, and a config that opts out", () => {
    expect(open(["--invite", "claude,agy", "--lead", "agy"]).roles.get("agy")).toBe("lead");
    const given = open(["--invite", "claude,agy", "--role", "agy=lead"]);
    expect([given.roles.get("claude"), given.roles.get("agy")]).toEqual([undefined, "lead"]);
    expect(open(["--invite", "claude,agy", "--no-lead"]).roles.size).toBe(0);
    expect(open(["--invite", "claude,agy"], { lead: false }).roles.size).toBe(0);
    expect(open(["--invite", "claude,agy"], { lead: ["agy", "claude"] }).roles.get("agy")).toBe("lead");
  });

  it("needs no lead for a single agent, nor on reopen", () => {
    expect(open(["--invite", "claude"]).roles.size).toBe(0);
    expect(withDefaults(parseOpenFlags(["--invite", "claude,codex"]), {}, false).roles.size).toBe(0);
  });
});
