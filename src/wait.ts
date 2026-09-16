import type Database from "better-sqlite3";
import { roomListen, roomSetStatus } from "./store.js";
import type { MessageInfo, RoomWaitResult } from "./types.js";

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Default hold. Long on purpose: every return costs a model inference, so a
 * short poll loop burns tokens even when the room is silent. Tune per client
 * with AI_ROOM_WAIT_MS — keep it below that client's hard per-call timeout.
 */
export const DEFAULT_WAIT_MS = envMs("AI_ROOM_WAIT_MS", 240_000);
/** Upper bound a caller may request. */
export const MAX_WAIT_MS = 1_500_000;
/**
 * Progress cadence. Default sits well under Claude Code's 300_000ms idle
 * timeout for http MCP servers. Tune with AI_ROOM_HEARTBEAT_MS.
 */
export const HEARTBEAT_MS = envMs("AI_ROOM_HEARTBEAT_MS", 20_000);

const NEXT_ACTION_MESSAGES =
  "Process every message now, do the work, room_send your reply, then call room_wait again.";
const NEXT_ACTION_TIMEOUT =
  "No messages. Call room_wait again immediately. Produce no other output and no commentary.";
const NEXT_ACTION_CANCELLED =
  "The wait was cancelled by the client. Call room_wait again unless you are leaving the room.";

interface Subscription {
  promise: Promise<void>;
  cancel: () => void;
}

export class RoomWaitRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();

  /**
   * Resolves on the first of: a message in `room`, `timeoutMs` elapsing, or
   * `signal` aborting. Aborting matters — without it a client that drops
   * mid-wait leaves this handler pending for the whole (now very long) hold.
   */
  subscribe(room: string, timeoutMs: number, signal?: AbortSignal): Subscription {
    let settled = false;
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      const roomWaiters = this.waiters.get(room);
      roomWaiters?.delete(finish);
      if (roomWaiters?.size === 0) this.waiters.delete(room);
      resolvePromise();
    };

    const roomWaiters = this.waiters.get(room) ?? new Set<() => void>();
    roomWaiters.add(finish);
    this.waiters.set(room, roomWaiters);
    const timer = setTimeout(finish, timeoutMs);

    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });

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

export interface RoomWaitOptions {
  signal?: AbortSignal;
  /** Called every `heartbeatMs` while holding, to keep client idle timers alive. */
  onHeartbeat?: (elapsedMs: number) => void;
  heartbeatMs?: number;
}

export async function roomWait(
  db: Database.Database,
  registry: RoomWaitRegistry,
  params: { room: string; agent: string; timeoutMs: number },
  options: RoomWaitOptions = {}
): Promise<RoomWaitResult> {
  const startedAt = Date.now();
  const settle = (messages: MessageInfo[], cancelled: boolean): RoomWaitResult => ({
    messages,
    status: messages.length > 0 ? "messages" : cancelled ? "cancelled" : "timeout",
    waitedMs: Date.now() - startedAt,
    nextAction:
      messages.length > 0
        ? NEXT_ACTION_MESSAGES
        : cancelled
          ? NEXT_ACTION_CANCELLED
          : NEXT_ACTION_TIMEOUT,
  });

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
  if (pending.length > 0) return settle(pending, false);

  const subscription = registry.subscribe(
    params.room,
    params.timeoutMs,
    options.signal
  );

  // Heartbeats also refresh last_seen_at, so a long-held waiter is not mistaken
  // for a dead agent by room_who or the /active endpoint.
  const heartbeat = options.onHeartbeat
    ? setInterval(() => {
        const elapsed = Date.now() - startedAt;
        roomSetStatus(db, {
          room: params.room,
          agent: params.agent,
          status: "waiting",
          detail: null,
        });
        options.onHeartbeat?.(elapsed);
      }, options.heartbeatMs ?? HEARTBEAT_MS)
    : undefined;

  try {
    const raced = receive();
    if (raced.length > 0) return settle(raced, false);
    await subscription.promise;
    return settle(receive(), options.signal?.aborted ?? false);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    subscription.cancel();
  }
}
