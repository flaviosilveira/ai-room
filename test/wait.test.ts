import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { roomJoin, roomSend, roomWho } from "../src/store.js";
import { RoomWaitRegistry, roomWait } from "../src/wait.js";
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
    expect(result.nextAction).toMatch(/call room_wait again/i);
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
});
