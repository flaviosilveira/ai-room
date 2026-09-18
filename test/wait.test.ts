import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { roomJoin, roomSend, roomWho } from "../src/store.js";
import {
  DEFAULT_WAIT_MS,
  FOREGROUND_BUDGET_MS,
  RoomWaitRegistry,
  roomWait,
  withWaitLiveness,
} from "../src/wait.js";
import type Database from "better-sqlite3";

describe("room_wait", () => {
  let db: Database.Database;
  let registry: RoomWaitRegistry;

  beforeEach(() => {
    db = openDb(":memory:");
    registry = new RoomWaitRegistry();
    roomJoin(db, { room: "r", agent: "claude" });
    roomJoin(db, { room: "r", agent: "codex" });
  });

  afterEach(() => db.close());

  it("returns pending messages immediately", async () => {
    roomSend(db, { room: "r", agent: "claude", message: "plan" });
    await expect(
      roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 100 })
    ).resolves.toMatchObject({
      status: "messages",
      messages: [{ content: "plan" }],
    });
  });

  it("reports a timeout without messages and leaves agent waiting", async () => {
    const result = await roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 5 });
    expect(result.messages).toEqual([]);
    expect(result.status).toBe("timeout");
    expect(result.nextAction).toMatch(/room_idle/i);
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")?.status).toBe("waiting");
    expect(registry.size()).toBe(0);
  });

  it("wakes on a message and marks the receiver working", async () => {
    const pending = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    roomSend(db, { room: "r", agent: "claude", message: "review" });
    registry.notify("r");

    await expect(pending).resolves.toMatchObject({
      status: "messages",
      messages: [{ content: "review" }],
    });
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")?.status).toBe("working");
    expect(registry.size()).toBe(0);
  });

  it("does not wake waiters in another room", async () => {
    roomJoin(db, { room: "other", agent: "agy" });
    const pending = roomWait(db, registry, { room: "other", agent: "agy", timeoutMs: 20 });
    registry.notify("r");
    await expect(pending).resolves.toMatchObject({ status: "timeout", messages: [] });
  });

  it("releases the subscription as soon as the client aborts", async () => {
    const controller = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.size()).toBe(1);

    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(registry.size()).toBe(0);
  });

  it("does not consume messages when the client aborts mid-wait", async () => {
    const controller = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Message lands, then the client goes away before it is delivered.
    roomSend(db, { room: "r", agent: "claude", message: "nao pode sumir" });
    registry.notify("r");
    controller.abort();

    const aborted = await pending;
    expect(aborted.status).toBe("cancelled");
    expect(aborted.messages).toEqual([]);

    // The next wait must still find it: an abandoned read consumes nothing.
    const next = await roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 50 });
    expect(next.messages.map((m) => m.content)).toEqual(["nao pode sumir"]);
  });

  it("emits heartbeats while holding so client idle timers stay alive", async () => {
    const beats: number[] = [];
    const result = await roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 120 },
      { heartbeatMs: 20, onHeartbeat: (elapsed) => beats.push(elapsed) }
    );
    expect(result.status).toBe("timeout");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(registry.size()).toBe(0);
  });

  it("survives the room disappearing under a parked waiter", async () => {
    const dropRoom = () => {
      for (const table of ["cursors", "messages", "participants", "room_profiles"]) {
        db.exec(`DELETE FROM ${table} WHERE room = 'r'`);
      }
      db.exec("DELETE FROM rooms WHERE name = 'r'");
    };

    // The heartbeat after this one writes a status for a room that is gone.
    // Thrown from a timer that reached the top level and killed the server.
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 2_000 },
      { heartbeatMs: 10, onHeartbeat: dropRoom }
    );

    const startedAt = Date.now();
    await expect(pending).rejects.toThrow(/does not exist/);
    // The guard stops the wait at the failing beat. Without it the timer kept
    // throwing until the hold expired, if the process lived that long.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(registry.size()).toBe(0);
  });

  it("settles instead of crashing when the heartbeat channel fails", async () => {
    let beats = 0;
    const result = await roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 2_000 },
      {
        heartbeatMs: 10,
        onHeartbeat: () => {
          beats += 1;
          throw new Error("notification channel closed");
        },
      }
    );

    expect(result.status).toBe("timeout");
    expect(result.waitedMs).toBeLessThan(500);
    // One failure is enough to end the wait; an unguarded timer kept firing.
    expect(beats).toBe(1);
    expect(registry.size()).toBe(0);
  });
});

describe("wait liveness", () => {
  let db: Database.Database;
  let registry: RoomWaitRegistry;

  beforeEach(() => {
    db = openDb(":memory:");
    registry = new RoomWaitRegistry();
    roomJoin(db, { room: "r", agent: "claude" });
    roomJoin(db, { room: "r", agent: "codex" });
  });
  afterEach(() => db.close());

  it("holds for less than the host's foreground budget by default", () => {
    // Claude Code moves an MCP call to the background at 120s; a default above
    // that guaranteed every quiet wait became a call nobody was reading.
    expect(DEFAULT_WAIT_MS).toBeLessThan(FOREGROUND_BUDGET_MS);
    expect(FOREGROUND_BUDGET_MS - DEFAULT_WAIT_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEFAULT_WAIT_MS).toBeGreaterThan(30_000);
  });

  it("reports a parked wait as live, per agent", async () => {
    const pending = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.isWaiting("r", "codex")).toBe(true);
    expect(registry.isWaiting("r", "claude")).toBe(false);
    expect(registry.waitingAgents("r")).toEqual(["codex"]);
    await pending;
  });

  it("drops liveness on timeout", async () => {
    await roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 5 });
    expect(registry.isWaiting("r", "codex")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("drops liveness on abort", async () => {
    const controller = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.isWaiting("r", "codex")).toBe(true);
    controller.abort();
    await pending;
    expect(registry.isWaiting("r", "codex")).toBe(false);
  });

  it("drops liveness when the transport disconnects mid-wait", async () => {
    // What a closed HTTP response does: the server aborts the request signal.
    const transport = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: transport.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    transport.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(registry.isWaiting("r", "codex")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("drops liveness when the wait throws", async () => {
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 2_000 },
      {
        heartbeatMs: 5,
        onHeartbeat: () => {
          db.exec("DELETE FROM participants WHERE room = 'r' AND agent = 'codex'");
          db.exec("DELETE FROM rooms WHERE name = 'r'");
        },
      }
    );
    await expect(pending).rejects.toThrow();
    expect(registry.isWaiting("r", "codex")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("keeps exactly one live wait per (room, agent)", async () => {
    // The backgrounded wait and the fresh one raced over the same cursor.
    const stale = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.size()).toBe(1);

    const fresh = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 200 });
    const replaced = await stale;
    expect(replaced.status).toBe("superseded");
    expect(replaced.messages).toEqual([]);
    expect(replaced.nextAction).toMatch(/do not call room_wait again/i);
    expect(registry.size()).toBe(1);
    expect(registry.isWaiting("r", "codex")).toBe(true);

    await fresh;
    expect(registry.size()).toBe(0);
  });

  it("a superseded wait consumes nothing, so the live one still gets the message", async () => {
    const stale = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const fresh = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 1_000 });
    expect((await stale).messages).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    roomSend(db, { room: "r", agent: "claude", message: "nao pode sumir" });
    registry.notify("r");
    expect((await fresh).messages.map((m) => m.content)).toEqual(["nao pode sumir"]);
  });

  it("keeps unread accurate across cancelled and live waits", async () => {
    const unread = () => roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.unread;
    expect(unread()).toBe(0);

    const controller = new AbortController();
    const abandoned = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await abandoned).toMatchObject({ status: "cancelled" });

    roomSend(db, { room: "r", agent: "claude", message: "um" });
    roomSend(db, { room: "r", agent: "claude", message: "dois" });
    // Nobody is listening any more, so both stay unread rather than vanishing.
    expect(unread()).toBe(2);

    const delivered = await roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 50 });
    expect(delivered.messages.map((m) => m.content)).toEqual(["um", "dois"]);
    expect(unread()).toBe(0);
  });

  it("consumes nothing for a client that is already gone when the wait starts", async () => {
    roomSend(db, { room: "r", agent: "claude", message: "pendente" });
    const controller = new AbortController();
    controller.abort();

    const result = await roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    expect(result.status).toBe("cancelled");
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")!.unread).toBe(1);
  });

  it("stops presenting a stale 'waiting' as a live wait", async () => {
    const controller = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "codex", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await pending;

    const [view] = withWaitLiveness(
      "r",
      roomWho(db, { room: "r" }).filter((p) => p.agent === "codex"),
      registry
    );
    // The agent's own last word stays "waiting" — we never invent a status we
    // did not observe — but the evidence behind it is gone and must show it.
    expect(view.status).toBe("waiting");
    expect(view.waitActive).toBe(false);
  });
});
