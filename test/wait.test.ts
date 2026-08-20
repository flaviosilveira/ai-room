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
    await expect(roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 100 })).resolves.toMatchObject([
      { content: "plan" },
    ]);
  });

  it("returns an empty array on timeout and leaves agent waiting", async () => {
    await expect(roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 5 })).resolves.toEqual([]);
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")?.status).toBe("waiting");
    expect(registry.size()).toBe(0);
  });

  it("wakes on a message and marks the receiver working", async () => {
    const pending = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    roomSend(db, { room: "r", agent: "claude", message: "review" });
    registry.notify("r");

    await expect(pending).resolves.toMatchObject([{ content: "review" }]);
    expect(roomWho(db, { room: "r" }).find((p) => p.agent === "codex")?.status).toBe("working");
    expect(registry.size()).toBe(0);
  });

  it("does not wake waiters in another room", async () => {
    roomJoin(db, { room: "other", agent: "agy" });
    const pending = roomWait(db, registry, { room: "other", agent: "agy", timeoutMs: 20 });
    registry.notify("r");
    await expect(pending).resolves.toEqual([]);
  });
});
