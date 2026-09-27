import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import {
  idleParticipantsWithUnread,
  mentionedAgents,
  roomCharter,
  roomHistory,
  roomIdle,
  roomJoin,
  roomSend,
  roomSetCharter,
} from "../src/store.js";
import { approvePlan, checkProposal, proposePlan } from "../src/cast.js";
import { agentsToLaunch, holdForPlan, parseOpenFlags } from "../src/open.js";
import { agentCommand } from "../src/invite.js";

const wake = (n: number) => ({ kind: "codex-queue" as const, id: `00000000-1111-2222-3333-44444444444${n}` });

describe("waking by address", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomJoin(db, { room: "r", agent: "claude", role: "lead" });
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "codex-2" });
    roomIdle(db, { room: "r", agent: "claude", wake: wake(1) });
    roomIdle(db, { room: "r", agent: "codex", wake: wake(2) });
    roomIdle(db, { room: "r", agent: "codex-2", wake: wake(3) });
  });
  afterEach(() => db.close());

  const woken = () => idleParticipantsWithUnread(db, "r").map((target) => target.agent).sort();

  it("wakes only the recipients of an addressed message", () => {
    roomSend(db, { room: "r", agent: "claude", message: "take the parser", to: ["codex"] });
    expect(woken()).toEqual(["codex"]);
  });

  it("wakes the whole room for a message with no recipients", () => {
    roomSend(db, { room: "r", agent: "codex", message: "found the bug" });
    expect(woken()).toEqual(["claude", "codex-2"]);
  });

  it("hands the human's plain words to the lead alone, and @names to whoever they name", () => {
    roomSend(db, { room: "r", agent: "human", origin: "human", message: "status?" });
    expect(woken()).toEqual(["claude"]);
    roomSend(db, { room: "r", agent: "human", origin: "human", message: "@codex-2 look", to: mentionedAgents(db, "r", "@codex-2 look") });
    expect(woken()).toEqual(["claude", "codex-2"]);
  });

  it("reads @names only at the start, and only for agents in the room", () => {
    expect(mentionedAgents(db, "r", "@codex @codex-2: check")).toEqual(["codex", "codex-2"]);
    expect(mentionedAgents(db, "r", "@all check")?.sort()).toEqual(["claude", "codex", "codex-2"]);
    expect(mentionedAgents(db, "r", "mail me at a@codex")).toBeUndefined();
    expect(mentionedAgents(db, "r", "@nobody hi")).toBeUndefined();
  });
});

describe("the lead's plan", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    const flags = { ...parseOpenFlags(["--brief", "Fix it", "--invite", "claude,codex"]) };
    const roster = holdForPlan([{ agent: "claude", role: "lead" }, { agent: "codex" }], flags, true);
    roomSetCharter(db, { room: "r", brief: "Fix it", roster });
    roomJoin(db, { room: "r", agent: "claude" });
  });
  afterEach(() => db.close());

  it("opens a new team with the lead alone", () => {
    const roster = roomCharter(db, "r")!.roster;
    expect(roster.find((entry) => entry.agent === "codex")?.held).toBe(true);
    expect(agentsToLaunch(parseOpenFlags([]), roster)).toEqual(["claude"]);
    expect(holdForPlan(roster, parseOpenFlags(["--brief", "x", "--no-plan"]), true)).toBe(roster);
  });

  it("refuses a plan from anyone but the lead, a lone agent, or a team all on light settings", () => {
    expect(proposePlan(db, "r", "codex", { size: "small", agents: [{ agent: "codex" }] }).detail).toMatch(/only the lead/);
    expect(checkProposal([{ agent: "claude" }])).toMatch(/at least two/);
    expect(checkProposal([{ agent: "claude", effort: "low" }, { agent: "agy", model: "gemini-3.8-flash-low" }])).toMatch(/light/);
    expect(checkProposal([{ agent: "claude", effort: "low" }, { agent: "codex", effort: "medium" }])).toBeNull();
  });

  it("tells the human the plan and applies it on approval", () => {
    const proposed = proposePlan(db, "r", "claude", {
      size: "small: 4 changes in 2 files",
      plan: ".ai-room/for-human/plan.md",
      agents: [{ agent: "codex", role: "reviewer", model: "gpt-5.5", effort: "medium" }],
    });
    expect(proposed.ok).toBe(true);
    const note = roomHistory(db, { room: "r" }).find((m) => m.agent === "claude");
    expect(note?.to).toEqual(["human"]);
    expect(note?.content).toMatch(/codex \(reviewer\): gpt-5.5 medium/);
    expect(note?.content).toMatch(/Decisions: .ai-room\/for-human\/plan.md/);

    expect(approvePlan(db, "r").ok).toBe(true);
    const charter = roomCharter(db, "r")!;
    expect(charter.proposal).toBeNull();
    expect(charter.roster.find((entry) => entry.agent === "codex")).toMatchObject({ role: "reviewer", model: "gpt-5.5", effort: "medium" });
    expect(charter.roster.find((entry) => entry.agent === "codex")?.held).toBeUndefined();
    expect(charter.roster.find((entry) => entry.agent === "claude")?.role).toBe("lead");
  });

  it("launches each harness at the level it was given", () => {
    expect(agentCommand("r", "codex", undefined, { model: "gpt-5.5", effort: "max" })?.slice(0, 5)).toEqual([
      "codex", "-m", "gpt-5.5", "-c", 'model_reasoning_effort="xhigh"',
    ]);
    expect(agentCommand("r", "claude-2", undefined, { effort: "high" })?.slice(0, 3)).toEqual(["claude", "--effort", "high"]);
    expect(agentCommand("r", "agy", undefined, { model: "gemini-3.8-flash-medium" })?.slice(0, 3)).toEqual(["agy", "--model", "gemini-3.8-flash-medium"]);
    expect(parseOpenFlags(["--effort", "codex=medium,agy=xhigh"]).efforts.get("agy")).toBe("max");
    expect(() => parseOpenFlags(["--effort", "codex=huge"])).toThrow(/one of/);
  });
});
