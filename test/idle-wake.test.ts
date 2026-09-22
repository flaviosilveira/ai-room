import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { createHttpApp } from "../src/http.js";
import {
  idleParticipantsWithUnread,
  markRead,
  roomIdle,
  roomJoin,
  roomListen,
  roomSend,
  roomSetStatus,
  roomWho,
  setWakeTarget,
} from "../src/store.js";
import { RoomWaitRegistry, roomWait, withWaitLiveness } from "../src/wait.js";
import {
  WAKE_KINDS,
  WakeService,
  isDirectDelivery,
  parseWakeSpec,
  wakeArgv,
  wakeMessage,
} from "../src/wake.js";
import { renderParticipant } from "../src/console.js";
import { harnessFor, joinPrompt } from "../src/invite.js";
import { reuseVerdict, classifyJoins } from "../src/open.js";
import { spawnSync } from "node:child_process";
import {
  detectMultiplexer,
  ensureWorkspace,
  killWorkspace,
  paneForAgent,
  workspaceName,
  tmuxArgv,
} from "../src/session.js";

const CODEX_WAKE = { kind: "codex-queue" as const, id: "00000000-1111-2222-3333-444444444444" };
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("idle lifecycle", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex", harness: "codex" });
    roomJoin(db, { room: "r", agent: "claude", harness: "claude" });
  });
  afterEach(() => db.close());

  const who = (agent: string) => roomWho(db, { room: "r" }).find((p) => p.agent === agent)!;

  it("records how the agent can be resumed", () => {
    const participant = roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    expect(participant.status).toBe("idle");
    expect(participant.wake).toEqual(CODEX_WAKE);
  });

  it("refuses to go idle for an agent that never joined", () => {
    expect(() => roomIdle(db, { room: "r", agent: "ghost", wake: CODEX_WAKE })).toThrow(/has not joined/);
  });

  it("leaves an idle agent alone while the room is silent", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    // Ten minutes of nothing: the only thing that may wake it is a message.
    expect(idleParticipantsWithUnread(db, "r")).toEqual([]);
    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toEqual([]);
  });

  it("wakes an idle agent exactly once when a message arrives", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "olha isso" });

    const calls: string[][] = [];
    const wake = new WakeService({ run: (argv) => (calls.push(argv), { ok: true }), minIntervalMs: 60_000 });
    wake.wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 4)).toEqual(["codex", "queue", "--thread", CODEX_WAKE.id]);
    expect(calls[0][5]).toContain("1 unread");
    // A burst must not become a burst of wakes.
    roomSend(db, { room: "r", agent: "claude", message: "e isso" });
    wake.wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
  });

  it("comes back for a message that arrived inside the rate limit", () => {
    // What the integrated smoke caught: an agent woken seconds earlier was
    // skipped for the next message and never revisited, so it slept with
    // something unread and nothing else on the way.
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "primeira" });

    const calls: string[][] = [];
    const pending: Array<() => void> = [];
    let clock = 0;
    const wake = new WakeService({
      run: (argv) => (calls.push(argv), { ok: true }),
      minIntervalMs: 10_000,
      now: () => clock,
      schedule: (run) => pending.push(run),
    });

    wake.wakeRoom(db, "r");
    expect(calls).toHaveLength(1);

    // Second message five seconds later: inside the window, so not now…
    clock = 5_000;
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "segunda" });
    wake.wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(1);

    // …but the retry does happen once the window is over.
    clock = 10_100;
    pending.pop()!();
    expect(calls).toHaveLength(2);
  });

  it("does not pile up retries for the same agent", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    const pending: Array<() => void> = [];
    const wake = new WakeService({
      run: () => ({ ok: true }),
      minIntervalMs: 10_000,
      now: () => 0,
      schedule: (run) => pending.push(run),
    });
    roomSend(db, { room: "r", agent: "claude", message: "um" });
    wake.wakeRoom(db, "r");
    for (const message of ["dois", "tres", "quatro"]) {
      roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
      roomSend(db, { room: "r", agent: "claude", message });
      wake.wakeRoom(db, "r");
    }
    expect(pending).toHaveLength(1);
  });

  it("never wakes an agent that is not idle", () => {
    roomSetStatus(db, { room: "r", agent: "codex", status: "working" });
    roomSend(db, { room: "r", agent: "claude", message: "trabalhe" });
    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toEqual([]);
  });

  it("keeps the way back when the agent reports another status", () => {
    // How to reach a session and what it is doing are different facts. Losing
    // the route on every status change left an agent that reported
    // approval_required unreachable, with messages waiting.
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    for (const status of ["working", "approval_required", "blocked"] as const) {
      roomSetStatus(db, { room: "r", agent: "codex", status });
      expect(who("codex").wake).toEqual(CODEX_WAKE);
    }
    // Reachable, but not woken: only an idle agent is resumed.
    roomSend(db, { room: "r", agent: "claude", message: "oi" });
    expect(idleParticipantsWithUnread(db, "r")).toEqual([]);

    roomIdle(db, { room: "r", agent: "codex" });
    expect(idleParticipantsWithUnread(db, "r").map((t) => t.agent)).toEqual(["codex"]);
  });

  it("refuses to go idle with no way back", () => {
    expect(() => roomIdle(db, { room: "r", agent: "claude" })).toThrow(/No way to resume/);
  });

  it("reuses the target the launcher registered", () => {
    setWakeTarget(db, {
      room: "r",
      agent: "claude",
      wake: { kind: "tmux-pane", id: "airoom-sala-abcdef1234" },
    });
    const idle = roomIdle(db, { room: "r", agent: "claude" });
    expect(idle.status).toBe("idle");
    expect(idle.wake).toEqual({ kind: "tmux-pane", id: "airoom-sala-abcdef1234" });
  });

  it("does not consume the messages it wakes for", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "para o codex" });
    new WakeService({ run: () => ({ ok: true }) }).wakeRoom(db, "r");
    expect(who("codex").unread).toBe(1);
    expect(roomListen(db, { room: "r", agent: "codex" }).map((m) => m.content)).toEqual(["para o codex"]);
  });

  it("records a failed wake instead of leaving it looking asleep", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "acorda" });
    new WakeService({ run: () => ({ ok: false, error: "codex exited 1" }) }).wakeRoom(db, "r");
    expect(who("codex").wakeError).toMatch(/exited 1/);
    expect(plain(renderParticipant({ ...who("codex"), waitActive: false }))).toMatch(/wake_failed/);
  });
});

describe("wake targets are data, never commands", () => {
  it("accepts only known harness kinds and id-shaped values", () => {
    expect(parseWakeSpec(CODEX_WAKE)).toEqual(CODEX_WAKE);
    expect(() => parseWakeSpec({ kind: "shell", id: "x" })).toThrow(/Unknown wake kind/);
    expect(() => parseWakeSpec({ kind: "claude-resume", id: "abc12345" })).toThrow(/Unknown wake kind/);
    expect(() => parseWakeSpec({ kind: "codex-queue", id: "a; rm -rf /" })).toThrow(/session id/);
    expect(() => parseWakeSpec({ kind: "codex-queue", id: "$(whoami)" })).toThrow(/session id/);
    expect(() => parseWakeSpec({ kind: "codex-queue", id: "short" })).toThrow(/session id/);
    expect(() => parseWakeSpec("codex")).toThrow();
  });

  it("refuses a pane target an agent made up for itself", () => {
    // Only the launcher knows which pane belongs to whom; a session id here is
    // a route to nowhere that the agent would then sleep behind.
    expect(() => parseWakeSpec({ kind: "tmux-pane", id: "11111111-2222-4333-8444-555555555555" })).toThrow(
      /registered by the launcher/
    );
    expect(parseWakeSpec({ kind: "tmux-pane", id: "airoom-sala-abcdef1234" })).toMatchObject({
      kind: "tmux-pane",
    });
  });

  it("reports a wake kind it no longer knows instead of crashing the send", () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    // A row left by an older version.
    db.exec("UPDATE participants SET wake_kind = 'claude-resume' WHERE agent = 'codex'");
    roomSend(db, { room: "r", agent: "claude", message: "oi" });

    const attempts = new WakeService({ run: () => ({ ok: true }) }).wakeRoom(db, "r");
    expect(attempts[0]).toMatchObject({ ok: false });
    expect(attempts[0].error).toMatch(/unknown wake kind/);
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.wakeError).toMatch(
      /unknown wake kind/
    );
    db.close();
  });

  it("builds a fixed argv where only the id and the notice vary", () => {
    const argv = wakeArgv(CODEX_WAKE, "hello");
    expect(argv).toEqual(["codex", "queue", "--thread", CODEX_WAKE.id, "--message", "hello"]);
  });

  it("reaches a TUI harness through its pane, not through a new process", () => {
    // `claude --resume … --bg` starts a copy of a running session: the copy
    // answers in the room while the session on screen stays asleep.
    expect(WAKE_KINDS).toContain("tmux-pane");
    expect(WAKE_KINDS).not.toContain("claude-resume");
    expect(isDirectDelivery("tmux-pane")).toBe(true);
    expect(wakeArgv({ kind: "tmux-pane", id: "airoom-sala-abcdef1234" }, "oi")).toBeNull();
  });

  it("says the notice is automated and carries no authority", () => {
    const message = wakeMessage("r", "codex", 2);
    expect(message).toMatch(/not a human instruction/i);
    expect(message).toMatch(/never human authorization/i);
    expect(message).toMatch(/2 unread/);
    // The notice must not carry what was said, only that something was said.
    expect(message).not.toMatch(/content/i);
  });
});

describe("the protocol stops telling agents to poll", () => {
  let db: Database.Database;
  let registry: RoomWaitRegistry;
  beforeEach(() => {
    db = openDb(":memory:");
    registry = new RoomWaitRegistry();
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
  });
  afterEach(() => db.close());

  it("never answers a wait with 'call room_wait again'", async () => {
    // Only the prohibition may mention it: "do not call room_wait again".
    const asksForAnotherWait = /(?<!do not )call room_wait again/i;
    const timeout = await roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 5 });
    expect(timeout.nextAction).not.toMatch(asksForAnotherWait);
    expect(timeout.nextAction).toMatch(/room_idle/);

    const controller = new AbortController();
    const cancelled = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await cancelled).nextAction).not.toMatch(asksForAnotherWait);
  });

  it("asks each harness only for what it can answer", () => {
    // Codex can name its own session; a pane-hosted harness cannot, and the
    // launcher registers the pane for it.
    expect(joinPrompt("r", "codex")).toContain("CODEX_THREAD_ID");
    expect(joinPrompt("r", "claude")).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(joinPrompt("r", "claude")).toMatch(/room_idle/);
    expect(joinPrompt("r", "codex")).toMatch(/never sit in a room_wait loop/i);
  });
});

describe("harness and instance are different things", () => {
  it("maps an instance name back to the CLI that runs it", () => {
    expect(harnessFor("claude")).toBe("claude");
    expect(harnessFor("claude-2")).toBe("claude");
    expect(harnessFor("codex-reviewer")).toBe("codex");
    expect(harnessFor("qa", "codex")).toBe("codex");
  });

  it("keeps two instances of one harness apart in a room", () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "claude-1", harness: "claude", role: "implementer" });
    roomJoin(db, { room: "r", agent: "claude-2", harness: "claude", role: "reviewer" });
    roomSend(db, { room: "r", agent: "claude-1", message: "feito" });

    const who = (agent: string) => roomWho(db, { room: "r" }).find((p) => p.agent === agent)!;
    expect(who("claude-1").harness).toBe("claude");
    expect(who("claude-2").harness).toBe("claude");
    expect(who("claude-1").role).toBe("implementer");
    expect(who("claude-2").role).toBe("reviewer");
    // Independent cursors: the sender reads nothing, the other reads one.
    expect(who("claude-1").unread).toBe(0);
    expect(who("claude-2").unread).toBe(1);

    roomIdle(db, { room: "r", agent: "claude-2", wake: { kind: "tmux-pane", id: "airoom-sala-abcdef1234" } });
    expect(who("claude-1").wake).toBeNull();
    expect(who("claude-2").wake).toMatchObject({ kind: "tmux-pane" });
    db.close();
  });
});

describe("the monitor reports what it can see", () => {
  let db: Database.Database;
  let registry: RoomWaitRegistry;
  beforeEach(() => {
    db = openDb(":memory:");
    registry = new RoomWaitRegistry();
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
  });
  afterEach(() => db.close());

  const view = (agent: string) =>
    withWaitLiveness("r", roomWho(db, { room: "r" }).filter((p) => p.agent === agent), registry)[0];

  it("shows idle as idle, not as activity", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    expect(plain(renderParticipant(view("codex")))).toBe("codex:idle");
  });

  it("shows an idle agent with unread as being woken", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "oi" });
    expect(plain(renderParticipant(view("codex")))).toBe("codex:idle(waking) unread:1");
  });

  it("surfaces an approval block instead of leaving it to the pane", () => {
    roomSetStatus(db, { room: "r", agent: "codex", status: "approval_required" });
    expect(plain(renderParticipant(view("codex")))).toBe("codex:blocked(approval)");
  });

  it("separates a finished agent from a live one", () => {
    roomSetStatus(db, { room: "r", agent: "codex", status: "done" });
    expect(plain(renderParticipant(view("codex")))).toBe("codex:finished");
  });
});

describe("a room is a task, not just a name", () => {
  it("reattaches silently, and refuses to merge two tasks in silence", () => {
    const base = { roomExists: true, messages: 12, currentBrief: "OP-3604", reuse: false };
    expect(reuseVerdict({ ...base, roomExists: false, newBrief: "nova" })).toEqual({ kind: "new" });
    expect(reuseVerdict({ ...base, newBrief: undefined })).toEqual({ kind: "reattach" });
    expect(reuseVerdict({ ...base, newBrief: "OP-3604" })).toEqual({ kind: "continue" });
    expect(reuseVerdict({ ...base, messages: 0, newBrief: "outra" })).toEqual({ kind: "continue" });
    expect(reuseVerdict({ ...base, newBrief: "OP-3406", reuse: true })).toEqual({ kind: "continue" });
    expect(reuseVerdict({ ...base, newBrief: "OP-3406" })).toMatchObject({ kind: "conflict", messages: 12 });
  });

  it("stops counting what the human has been watching as unread", () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomJoin(db, { room: "r", agent: "claude" });
    for (const message of ["um", "dois", "tres"]) {
      roomSend(db, { room: "r", agent: "claude", message });
    }
    const human = () => roomWho(db, { room: "r" }).find((p) => p.agent === "human")!;
    expect(human().unread).toBe(3);

    // What the live feed does as it prints each message to the console.
    markRead(db, { room: "r", agent: "human", upToId: 3 });
    expect(human().unread).toBe(0);
    db.close();
  });
});

describe("open reports whether the agents actually joined", () => {
  const launched = [
    { agent: "claude", harness: "claude" },
    { agent: "codex", harness: "codex" },
  ];

  it("calls a pane that never joined a failure, not a participant", () => {
    const reports = classifyJoins(launched, new Set(["claude"]), 45_000, 45_000);
    expect(reports.find((r) => r.agent === "claude")!.state).toBe("joined");
    const failed = reports.find((r) => r.agent === "codex")!;
    expect(failed.state).toBe("join_failed");
    expect(failed.detail).toMatch(/trust or approval prompt/);
  });

  it("says starting while the grace period is still running", () => {
    expect(classifyJoins(launched, new Set(), 2_000, 45_000).map((r) => r.state)).toEqual([
      "starting",
      "starting",
    ]);
  });
});

describe("going idle is a decision about everything said so far", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
  });
  afterEach(() => db.close());

  it("still wakes for a message that landed while it was going to sleep", () => {
    // The gap between the agent's last drain and its room_idle call is real:
    // burying whatever arrives there would strand the message until somebody
    // else happened to speak.
    roomSend(db, { room: "r", agent: "claude", message: "chegou na virada" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });

    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
  });

  it("stops resuming an agent that keeps ignoring the same messages", () => {
    roomSend(db, { room: "r", agent: "claude", message: "leia isto" });
    const calls: string[][] = [];
    const wake = new WakeService({ run: (argv) => (calls.push(argv), { ok: true }), minIntervalMs: 0 });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
      wake.wakeRoom(db, "r");
    }
    // Two resumes for one unread position, then it is left alone instead of
    // being woken forever.
    expect(calls).toHaveLength(2);
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.unread).toBe(1);
  });

  it("starts counting again once the agent actually reads", () => {
    roomSend(db, { room: "r", agent: "claude", message: "um" });
    const calls: string[][] = [];
    const wake = new WakeService({ run: (argv) => (calls.push(argv), { ok: true }), minIntervalMs: 0 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
      wake.wakeRoom(db, "r");
    }
    expect(calls).toHaveLength(2);

    roomListen(db, { room: "r", agent: "codex" });
    roomSend(db, { room: "r", agent: "claude", message: "dois" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    wake.wakeRoom(db, "r");
    expect(calls).toHaveLength(3);
  });

  it("wakes for anything that arrives after it fell asleep", () => {
    roomSend(db, { room: "r", agent: "claude", message: "antiga" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "nova" });

    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
  });

  it("ignores an agent's own messages as a reason to wake it", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "codex", message: "eu mesmo" });
    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toEqual([]);
  });
});

describe("no state where an agent is both asleep and running", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
  });
  afterEach(() => db.close());

  const who = (agent: string) => roomWho(db, { room: "r" }).find((p) => p.agent === agent)!;

  it("leaves idle the moment the agent acts again", () => {
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "codex", message: "acordei e respondi" });
    expect(who("codex").status).toBe("working");
    expect(who("codex").wake).toEqual(CODEX_WAKE);
    // And a second message must not "resume" a session that is already running.
    roomSend(db, { room: "r", agent: "claude", message: "mais uma" });
    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toEqual([]);
  });

  it("leaves idle when the agent only reads", () => {
    roomSend(db, { room: "r", agent: "claude", message: "oi" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomListen(db, { room: "r", agent: "codex" });
    expect(who("codex").status).toBe("working");
    expect(who("codex").wake).toEqual(CODEX_WAKE);
  });

  it("never advances an agent's cursor from the human's feed", () => {
    roomSend(db, { room: "r", agent: "claude", message: "para o codex" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    // What /stream does for whoever is watching — pointed at an agent by mistake.
    markRead(db, { room: "r", agent: "codex", upToId: 999 });
    expect(who("codex").unread).toBe(1);

    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "r");
    expect(calls).toHaveLength(1);
  });

  it("does not invent a cursor for someone who never joined the room", () => {
    markRead(db, { room: "r", agent: "ninguem", upToId: 5 });
    expect(roomWho(db, { room: "r" }).some((p) => p.agent === "ninguem")).toBe(false);
  });
});

describe("existing rooms keep working", () => {
  it("treats participants from before this version as ordinary agents", () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "velha", agent: "claude" });
    roomJoin(db, { room: "velha", agent: "codex" });
    // Simulates a row written by an older ai-room: no harness, no wake columns.
    db.exec(
      "UPDATE participants SET harness = NULL, wake_kind = NULL, wake_id = NULL, idle_mark = 0 WHERE room = 'velha'"
    );
    roomSend(db, { room: "velha", agent: "claude", message: "mensagem antiga" });

    const codex = roomWho(db, { room: "velha" }).find((p) => p.agent === "codex")!;
    expect(codex.status).toBe("working");
    expect(codex.wake).toBeNull();
    expect(codex.unread).toBe(1);
    // Nothing to resume, so nothing is attempted.
    const calls: string[][] = [];
    new WakeService({ run: (argv) => (calls.push(argv), { ok: true }) }).wakeRoom(db, "velha");
    expect(calls).toEqual([]);
    db.close();
  });
});

describe("a wake never holds the server", () => {
  it("dispatches without waiting for the harness to answer", async () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "acorda" });

    // The real wake runs a CLI; this stands in for one that takes its time.
    let settled = false;
    const wake = new WakeService({
      run: () => {
        setTimeout(() => {
          settled = true;
        }, 50);
        return { ok: true };
      },
    });
    const startedAt = Date.now();
    const attempts = wake.wakeRoom(db, "r");
    expect(Date.now() - startedAt).toBeLessThan(40);
    expect(attempts).toHaveLength(1);
    expect(settled).toBe(false);
    db.close();
  });

  it("records a failure reported after the call returned", async () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "claude" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
    roomSend(db, { room: "r", agent: "claude", message: "acorda" });

    let report: ((error: string) => void) | undefined;
    new WakeService({
      run: (_argv, onFailure) => {
        report = onFailure;
        return { ok: true };
      },
    }).wakeRoom(db, "r");

    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.wakeError).toBeNull();
    report!("codex exited 1");
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.wakeError).toMatch(/exited 1/);
    db.close();
  });
});

describe("the whole server shares one wake service", () => {
  let db: Database.Database;
  let server: import("node:http").Server;
  let baseUrl: URL;
  let calls: string[][];

  beforeEach(async () => {
    db = openDb(":memory:");
    calls = [];
    const wake = new WakeService({
      run: (argv) => (calls.push(argv), { ok: true }),
      minIntervalMs: 60_000,
    });
    server = await new Promise<import("node:http").Server>((resolve) => {
      const s = createHttpApp(db, wake).listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomIdle(db, { room: "r", agent: "codex", wake: CODEX_WAKE });
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const say = (message: string) =>
    fetch(new URL("/say", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "r", message }),
    });

  it("rate-limits across requests, not within one", async () => {
    await say("primeira");
    await say("segunda");
    await say("terceira");
    // A per-request service would have woken the agent three times.
    expect(calls).toHaveLength(1);
  });
});

describe.skipIf(!detectMultiplexer("tmux"))("waking the pane a TUI harness lives in", () => {
  const tmux = detectMultiplexer("tmux")!;
  const room = `vitest-pane-${process.pid}`;
  const session = workspaceName(room);
  let db: Database.Database;
  let sink: string;

  beforeEach(() => {
    db = openDb(":memory:");
    sink = path.join(os.tmpdir(), `airoom-pane-${process.pid}-${Date.now()}.txt`);
    // A pane that writes whatever is typed into it, standing in for the harness
    // prompt: what lands in the file is what the harness would have received.
    ensureWorkspace(tmux, session, process.cwd(), [
      { title: "claude", command: ["sh", "-c", `cat > ${sink}`] },
    ]);
    roomJoin(db, { room, agent: "claude", harness: "claude" });
    roomJoin(db, { room, agent: "codex", harness: "codex" });
  });

  afterEach(() => {
    killWorkspace(tmux, session);
    db.close();
    fs.rmSync(sink, { force: true });
  });

  it("types the notice into the agent's own pane, starting nothing new", async () => {
    setWakeTarget(db, { room, agent: "claude", wake: { kind: "tmux-pane", id: session } });
    roomIdle(db, { room, agent: "claude" });
    roomSend(db, { room, agent: "codex", message: "mensagem de outro agente" });

    // Real delivery: no injected runner, so this is the production path.
    const attempts = new WakeService().wakeRoom(db, room);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ agent: "claude", kind: "tmux-pane", ok: true });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const delivered = fs.readFileSync(sink, "utf8");
    expect(delivered).toContain("1 unread message(s)");
    expect(delivered).toContain(room);
    // The notice says what it is, and never carries what was said.
    expect(delivered).toContain("not a human instruction");
    expect(delivered).not.toContain("mensagem de outro agente");
    // Enter was pressed, so the harness sees a submitted line.
    expect(delivered.endsWith("\n")).toBe(true);
  });

  it("does not type into a pane a human is reading", () => {
    setWakeTarget(db, { room, agent: "claude", wake: { kind: "tmux-pane", id: session } });
    roomIdle(db, { room, agent: "claude" });
    roomSend(db, { room, agent: "codex", message: "agora" });

    const paneId = paneForAgent(session, "claude")!;
    spawnSync(...tmuxArgv(["copy-mode", "-t", paneId]));
    const attempts = new WakeService().wakeRoom(db, room);
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].error).toMatch(/copy-mode/);
    expect(roomWho(db, { room }).find((p) => p.agent === "claude")!.wakeError).toMatch(/copy-mode/);
  });

  it("reports a pane that is gone instead of pretending the agent sleeps", () => {
    setWakeTarget(db, { room, agent: "claude", wake: { kind: "tmux-pane", id: session } });
    roomIdle(db, { room, agent: "claude" });
    killWorkspace(tmux, session);
    roomSend(db, { room, agent: "codex", message: "ola" });

    const attempts = new WakeService().wakeRoom(db, room);
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].error).toMatch(/no pane/);
  });
});
