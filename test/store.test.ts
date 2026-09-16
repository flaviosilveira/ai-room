import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import {
  roomHistory,
  roomJoin,
  roomLeave,
  roomListen,
  roomList,
  roomSend,
  roomSetStatus,
  roomWho,
} from "../src/store.js";
import Database from "better-sqlite3";

describe("ai-room store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates/joins a room and returns room + participant info", () => {
    const result = roomJoin(db, { room: "backend-auth", agent: "claude", role: "implementer" });
    expect(result.created).toBe(true);
    expect(result.room.name).toBe("backend-auth");
    expect(result.participant.agent).toBe("claude");
    expect(result.participant.role).toBe("implementer");
    expect(result.participant.active).toBe(true);
  });

  it("preserves legacy room_join creation and can reject accidental room creation", () => {
    expect(roomJoin(db, { room: "existing", agent: "claude" }).created).toBe(true);
    expect(roomJoin(db, { room: "existing", agent: "codex", createIfMissing: false }).created).toBe(
      false
    );
    expect(() =>
      roomJoin(db, { room: "exsiting", agent: "codex", createIfMissing: false })
    ).toThrow(/does not exist/i);
    expect(roomList(db, {}).map((room) => room.name)).toEqual(["existing"]);
  });

  it("lists persistent workspaces and filters by case-insensitive query tokens", () => {
    roomJoin(db, { room: "Sylvan-client-refund-review", agent: "claude" });
    roomJoin(db, { room: "backend-auth", agent: "codex" });
    roomSend(db, { room: "Sylvan-client-refund-review", agent: "claude", message: "plan" });

    const matches = roomList(db, { query: "sylvan refund" });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      name: "Sylvan-client-refund-review",
      participantCount: 1,
      activeParticipantCount: 1,
    });
  });

  it("supports two agents joining the same room", () => {
    roomJoin(db, { room: "backend-auth", agent: "claude" });
    roomJoin(db, { room: "backend-auth", agent: "codex" });
    const who = roomWho(db, { room: "backend-auth" });
    const agents = who.map((p) => p.agent).sort();
    expect(agents).toEqual(["claude", "codex"]);
  });

  it("full multi-agent flow: send, listen, no self-echo, independent cursors, history, second message", () => {
    roomJoin(db, { room: "backend-auth", agent: "claude" });
    roomJoin(db, { room: "backend-auth", agent: "codex" });
    roomJoin(db, { room: "backend-auth", agent: "agy" });

    // 3. Claude sends a message
    const msg1 = roomSend(db, {
      room: "backend-auth",
      agent: "claude",
      message: "Found the race condition in refreshToken().",
    });

    // 4. Codex listens and receives it
    const codexFirst = roomListen(db, { room: "backend-auth", agent: "codex" });
    expect(codexFirst).toHaveLength(1);
    expect(codexFirst[0].id).toBe(msg1.id);
    expect(codexFirst[0].agent).toBe("claude");

    // 5. AGY listens and receives the same message
    const agyFirst = roomListen(db, { room: "backend-auth", agent: "agy" });
    expect(agyFirst).toHaveLength(1);
    expect(agyFirst[0].id).toBe(msg1.id);

    // 6. Claude does not receive its own message as new
    const claudeFirst = roomListen(db, { room: "backend-auth", agent: "claude" });
    expect(claudeFirst).toHaveLength(0);

    // 7. Codex listens again -> zero new messages
    const codexSecondEmpty = roomListen(db, { room: "backend-auth", agent: "codex" });
    expect(codexSecondEmpty).toHaveLength(0);

    // 8. Claude sends a second message
    const msg2 = roomSend(db, {
      room: "backend-auth",
      agent: "claude",
      message: "Review: risk of deadlock in X.",
    });

    // 9. Codex receives only the second message
    const codexSecond = roomListen(db, { room: "backend-auth", agent: "codex" });
    expect(codexSecond).toHaveLength(1);
    expect(codexSecond[0].id).toBe(msg2.id);

    // 10. history returns both messages chronologically
    const history = roomHistory(db, { room: "backend-auth" });
    expect(history.map((m) => m.id)).toEqual([msg1.id, msg2.id]);

    // 12. AGY's cursor is independent of Codex's — AGY still has msg2 pending
    const agySecond = roomListen(db, { room: "backend-auth", agent: "agy" });
    expect(agySecond).toHaveLength(1);
    expect(agySecond[0].id).toBe(msg2.id);
  });

  it("history supports after/before/agent filters", () => {
    roomJoin(db, { room: "r", agent: "claude" });
    const m1 = roomSend(db, { room: "r", agent: "claude", message: "one" });
    const m2 = roomSend(db, { room: "r", agent: "codex", message: "two" });
    roomSend(db, { room: "r", agent: "claude", message: "three" });

    expect(roomHistory(db, { room: "r", after: m1.id }).map((m) => m.content)).toEqual([
      "two",
      "three",
    ]);
    expect(roomHistory(db, { room: "r", before: m2.id }).map((m) => m.content)).toEqual(["one"]);
    expect(roomHistory(db, { room: "r", agent: "codex" }).map((m) => m.content)).toEqual(["two"]);
  });

  it("room_who lists participants and room_leave marks inactive without deleting history", () => {
    roomJoin(db, { room: "r", agent: "claude" });
    roomJoin(db, { room: "r", agent: "codex" });
    roomSend(db, { room: "r", agent: "claude", message: "hi" });

    roomLeave(db, { room: "r", agent: "claude" });

    const who = roomWho(db, { room: "r" });
    const claude = who.find((p) => p.agent === "claude")!;
    expect(claude.active).toBe(false);

    expect(roomHistory(db, { room: "r" })).toHaveLength(1);
  });

  it("persists messages across a store restart", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-room-test-")), "ai-room.sqlite");

    const db1 = openDb(dbPath);
    roomJoin(db1, { room: "r", agent: "claude" });
    roomJoin(db1, { room: "r", agent: "codex" });
    roomSend(db1, { room: "r", agent: "claude", message: "persisted message" });
    roomListen(db1, { room: "r", agent: "codex" });
    db1.close();

    const db2 = openDb(dbPath);
    const history = roomHistory(db2, { room: "r" });
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("persisted message");
    expect(history[0].origin).toBe("agent");

    // codex's cursor was also persisted -> no new messages on restart
    const codexAfterRestart = roomListen(db2, { room: "r", agent: "codex" });
    expect(codexAfterRestart).toHaveLength(0);
    db2.close();

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("stores observable participant status", () => {
    roomJoin(db, { room: "r", agent: "agy" });
    roomSetStatus(db, {
      room: "r",
      agent: "agy",
      status: "approval_required",
      detail: "Waiting for approval: run integration command",
    });

    expect(roomWho(db, { room: "r" })[0]).toMatchObject({
      status: "approval_required",
      statusDetail: "Waiting for approval: run integration command",
    });

    roomLeave(db, { room: "r", agent: "agy" });
    expect(roomWho(db, { room: "r" })[0]).toMatchObject({ status: "done", active: false });
  });

  it("migrates a v0.0.1 database without losing data", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-room-migration-")), "db.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE rooms (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE participants (
        room TEXT NOT NULL REFERENCES rooms(name), agent TEXT NOT NULL, role TEXT,
        joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (room, agent)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(name),
        agent TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE cursors (
        room TEXT NOT NULL REFERENCES rooms(name), agent TEXT NOT NULL,
        last_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room, agent)
      );
      INSERT INTO rooms VALUES ('legacy', 1);
      INSERT INTO participants VALUES ('legacy', 'claude', NULL, 1, 1, 1);
      INSERT INTO messages (room, agent, content, created_at) VALUES ('legacy', 'claude', 'kept', 1);
      INSERT INTO cursors VALUES ('legacy', 'claude', 0);
    `);
    legacy.close();

    const migrated = openDb(dbPath);
    expect(roomHistory(migrated, { room: "legacy" })[0]).toMatchObject({
      content: "kept",
      origin: "agent",
    });
    expect(roomWho(migrated, { room: "legacy" })[0]).toMatchObject({ status: "working" });
    migrated.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

describe("room_history windowing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "claude" });
    for (let i = 1; i <= 120; i += 1) {
      roomSend(db, { room: "r", agent: "claude", message: `m${i}` });
    }
  });

  afterEach(() => db.close());

  it("returns the most recent messages, in chronological order", () => {
    const rows = roomHistory(db, { room: "r", limit: 5 });
    expect(rows.map((m) => m.content)).toEqual(["m116", "m117", "m118", "m119", "m120"]);
  });

  it("pages forward from `after` with the oldest matches past that id", () => {
    const first = roomHistory(db, { room: "r", limit: 3, after: 0 });
    expect(first.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
    const next = roomHistory(db, { room: "r", limit: 3, after: first[2].id });
    expect(next.map((m) => m.content)).toEqual(["m4", "m5", "m6"]);
  });

  it("pages backward from `before` with the newest matches under that id", () => {
    const rows = roomHistory(db, { room: "r", limit: 3, before: 11 });
    expect(rows.map((m) => m.content)).toEqual(["m8", "m9", "m10"]);
  });
});

describe("rooms are never conjured by accident", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "real", agent: "claude" });
  });

  afterEach(() => db.close());

  it("refuses room_send into a room that does not exist", () => {
    expect(() => roomSend(db, { room: "reall", agent: "claude", message: "x" })).toThrow(
      /does not exist/
    );
    expect(roomList(db, {}).map((r) => r.name)).toEqual(["real"]);
  });

  it("refuses room_listen on a room that does not exist", () => {
    expect(() => roomListen(db, { room: "typo", agent: "claude" })).toThrow(/does not exist/);
    expect(roomList(db, {}).map((r) => r.name)).toEqual(["real"]);
  });

  it("still allows send and listen in a joined room", () => {
    roomJoin(db, { room: "real", agent: "codex" });
    roomSend(db, { room: "real", agent: "codex", message: "hi" });
    expect(roomListen(db, { room: "real", agent: "claude" }).map((m) => m.content)).toEqual(["hi"]);
  });
});
