import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomCharter, roomJoin, roomSetCharter } from "../src/store.js";
import {
  DRIVERS_FOR_TEST,
  detectMultiplexer,
  ensureWorkspace,
  killWorkspace,
  sessionExists,
  sessionName,
  workspaceName,
  workspacePanes,
} from "../src/session.js";
import { agentCommand, joinPrompt, planWorkspace } from "../src/invite.js";
import { TOOL_CATALOG, TOOL_NAMES } from "../src/catalog.js";

describe("workspace naming and isolation", () => {
  it("gives each room its own workspace session, deterministically", () => {
    expect(workspaceName("refactor-auth")).toMatch(/^airoom-refactor-auth-[0-9a-f]{10}$/);
    expect(workspaceName("a")).not.toBe(workspaceName("b"));
    // Reattach depends on the same room always resolving to the same session.
    expect(workspaceName("refactor-auth")).toBe(workspaceName("refactor-auth"));
  });

  it("keeps rooms distinct even when their slugs are identical", () => {
    // Slugging alone maps all of these to "airoom-refactor-auth", which would
    // drop three different rooms into one workspace.
    const names = ["refactor:auth", "refactor auth", "refactor-auth", "refactor.auth"]
      .map(workspaceName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("emits tmux-safe names for messy room names", () => {
    for (const room of ["OP-3563/auth fix", "teste com espaços", "a:b.c/d"]) {
      expect(workspaceName(room)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never lets a per-agent session collide with a workspace", () => {
    expect(workspaceName("r-codex")).not.toBe(sessionName("r", "codex"));
    expect(sessionName("a", "b-c")).not.toBe(sessionName("a-b", "c"));
  });

  it("never emits a kill-server command", () => {
    expect(DRIVERS_FOR_TEST.tmux.kill("airoom-r")).toEqual(["kill-session", "-t", "airoom-r"]);
    expect(DRIVERS_FOR_TEST.tmux.kill("airoom-r").join(" ")).not.toContain("kill-server");
  });

  it("only tmux claims pane support", () => {
    expect(DRIVERS_FOR_TEST.tmux.supportsPanes).toBe(true);
    expect(DRIVERS_FOR_TEST.screen.supportsPanes).toBe(false);
  });
});

describe("launch commands", () => {
  it("runs every harness interactively so approval prompts survive", () => {
    expect(agentCommand("r", "claude")).toEqual(["claude", joinPrompt("r", "claude")]);
    expect(agentCommand("r", "codex")).toEqual(["codex", joinPrompt("r", "codex")]);
    expect(agentCommand("r", "agy")).toEqual(["agy", "-i", joinPrompt("r", "agy")]);
  });

  it("returns null for an unknown harness instead of guessing", () => {
    expect(agentCommand("r", "nope")).toBeNull();
  });

  it("tells the agent that talking to a human is not leaving the room", () => {
    // A direct terminal conversation interrupts room_wait; without this the
    // agent answers the human and silently stops participating.
    const prompt = joinPrompt("r", "codex");
    expect(prompt).toMatch(/room_wait again/);
    expect(prompt).toMatch(/room_leave/);
  });

  it("keeps the seed prompt minimal: the charter is fetched, never inlined", () => {
    const prompt = joinPrompt("refactor-auth", "codex");
    expect(prompt).toMatch(/room_join/);
    expect(prompt).toMatch(/room_wait/);
    expect(prompt).toMatch(/briefing/i);
    // The charter's own content must not be duplicated into the prompt.
    expect(prompt).not.toMatch(/caveman|graphify|reviewer|validator/i);
    expect(prompt.length).toBeLessThan(600);
  });
});

describe("workspace planning", () => {
  it("adds a monitor pane alongside the agents", () => {
    const plan = planWorkspace("r", []);
    expect(plan.panes.map((p) => p.title)).toEqual(["monitor"]);
    // Must resolve to something runnable: a repo checkout has no ai-room on PATH.
    const [bin, ...rest] = plan.panes[0].command;
    expect(bin === "ai-room" || bin === process.execPath).toBe(true);
    expect(rest).toContain("console");
    expect(rest).toContain("r");
  });

  it("omits the monitor when asked", () => {
    expect(planWorkspace("r", [], { monitor: false }).panes).toEqual([]);
  });

  it("reports harnesses that are not installed instead of failing", () => {
    const plan = planWorkspace("r", ["definitely-not-a-real-agent"], { monitor: false });
    expect(plan.missing).toEqual(["definitely-not-a-real-agent"]);
    expect(plan.agents).toEqual([]);
    expect(plan.panes).toEqual([]);
  });
});

describe("charter is written before any agent starts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("has the briefing ready for the first room_join", () => {
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomSetCharter(db, {
      room: "r",
      brief: "Refatorar auth.",
      conventionPreset: "caveman",
      tools: ["graphify"],
      roster: [{ agent: "codex", role: "reviewer" }],
    });
    // An agent racing to join must already find its role waiting.
    const joined = roomJoin(db, { room: "r", agent: "codex" });
    expect(joined.briefing?.you).toMatchObject({ role: "reviewer" });
    expect(joined.briefing?.conventions).toMatch(/terse/i);
    expect(joined.briefing?.tools[0].name).toBe("graphify");
  });

  it("treats a declared tool as inert data, never as something to run", () => {
    roomJoin(db, { room: "r", agent: "human" });
    // A tool nobody has installed still stores cleanly: declaring is not running,
    // and the server never checks for or invokes what a charter names.
    roomSetCharter(db, {
      room: "r",
      tools: ["graphify", { name: "not-installed-anywhere", purpose: "x" }],
    });
    const tools = roomCharter(db, "r")!.tools;
    expect(tools.map((t) => t.name)).toEqual(["graphify", "not-installed-anywhere"]);
    for (const tool of tools) {
      for (const value of Object.values(tool)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  it("describes graphify as usage guidance, not as a prerequisite", () => {
    roomJoin(db, { room: "r", agent: "human" });
    roomSetCharter(db, { room: "r", tools: ["graphify"] });
    const tool = roomCharter(db, "r")!.tools[0];
    expect(tool.purpose).toBeTruthy();
    expect(tool.howToUse).toMatch(/graphify/);
    // Guidance may mention how to install; it must never order it.
    expect(JSON.stringify(tool)).not.toMatch(/you must install|install it first|required before/i);
  });
});

describe("tool catalog", () => {
  it("lists every tool exactly once", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect(TOOL_CATALOG).toHaveLength(11);
  });

  it("marks the read-only tools", () => {
    const readOnly = TOOL_CATALOG.filter((t) => !t.mutates).map((t) => t.name).sort();
    expect(readOnly).toEqual(["room_charter", "room_history", "room_list", "room_who"]);
  });
});

// Real tmux, skipped automatically where it is absent.
const tmux = detectMultiplexer("tmux");
describe.skipIf(!tmux)("tmux workspace lifecycle (real tmux)", () => {
  const room = `vitest-${process.pid}`;
  const session = workspaceName(room);
  const pane = (title: string) => ({ title, command: ["sh", "-c", "sleep 60"] });

  afterEach(() => {
    if (tmux) killWorkspace(tmux, session);
  });

  it("creates, extends on reopen, and stays idempotent", () => {
    const first = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);
    expect(first.created).toBe(true);
    expect(first.panes).toEqual(["claude"]);

    const second = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex")]);
    expect(second.created).toBe(false);
    expect(second.panes).toEqual(["codex"]);
    expect(second.skipped).toEqual(["claude"]);
    expect(workspacePanes(tmux!, session).sort()).toEqual(["claude", "codex"]);

    const third = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex")]);
    expect(third.panes).toEqual([]);
  });

  it("survives agents renaming their own pane title", () => {
    // Codex rewrites its pane title to "[ ! ] Action Required | ai-room".
    // Identity must not depend on anything the agent can overwrite, or
    // reopening a room duplicates every pane.
    const renaming = (title: string) => ({
      title,
      command: ["sh", "-c", `printf '\\033]2;HIJACKED\\033\\\\'; sleep 60`],
    });
    ensureWorkspace(tmux!, session, process.cwd(), [renaming("codex")]);
    const again = ensureWorkspace(tmux!, session, process.cwd(), [renaming("codex")]);
    expect(again.panes).toEqual([]);
    expect(again.skipped).toEqual(["codex"]);
    expect(workspacePanes(tmux!, session)).toEqual(["codex"]);
  });

  it("keeps rooms in separate sessions", () => {
    const other = workspaceName(`${room}-other`);
    ensureWorkspace(tmux!, session, process.cwd(), [pane("a")]);
    ensureWorkspace(tmux!, other, process.cwd(), [pane("a")]);
    expect(sessionExists(tmux!, session)).toBe(true);
    expect(sessionExists(tmux!, other)).toBe(true);

    killWorkspace(tmux!, other);
    // Closing one workspace must not touch the other.
    expect(sessionExists(tmux!, other)).toBe(false);
    expect(sessionExists(tmux!, session)).toBe(true);
  });
});
