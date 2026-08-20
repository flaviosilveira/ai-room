import type Database from "better-sqlite3";
import { roomListen, roomSetStatus } from "./store.js";
import type { MessageInfo } from "./types.js";

interface Subscription {
  promise: Promise<void>;
  cancel: () => void;
}

export class RoomWaitRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();

  subscribe(room: string, timeoutMs: number): Subscription {
    let settled = false;
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const roomWaiters = this.waiters.get(room);
      roomWaiters?.delete(finish);
      if (roomWaiters?.size === 0) this.waiters.delete(room);
      resolvePromise();
    };

    const roomWaiters = this.waiters.get(room) ?? new Set<() => void>();
    roomWaiters.add(finish);
    this.waiters.set(room, roomWaiters);
    const timer = setTimeout(finish, timeoutMs);

    return { promise, cancel: finish };
  }

  notify(room: string): void {
    for (const finish of [...(this.waiters.get(room) ?? [])]) finish();
  }

  size(): number {
    let count = 0;
    for (const roomWaiters of this.waiters.values()) count += roomWaiters.size;
    return count;
  }
}

export async function roomWait(
  db: Database.Database,
  registry: RoomWaitRegistry,
  params: { room: string; agent: string; timeoutMs: number }
): Promise<MessageInfo[]> {
  roomSetStatus(db, {
    room: params.room,
    agent: params.agent,
    status: "waiting",
    detail: null,
  });

  const receive = () => {
    const messages = roomListen(db, { room: params.room, agent: params.agent });
    if (messages.length > 0) {
      roomSetStatus(db, {
        room: params.room,
        agent: params.agent,
        status: "working",
        detail: null,
      });
    }
    return messages;
  };

  const pending = receive();
  if (pending.length > 0) return pending;

  const subscription = registry.subscribe(params.room, params.timeoutMs);
  try {
    const raced = receive();
    if (raced.length > 0) return raced;
    await subscription.promise;
    return receive();
  } finally {
    subscription.cancel();
  }
}
