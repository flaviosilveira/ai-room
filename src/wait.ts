import type Database from "better-sqlite3";
import { roomListen, roomSetStatus } from "./store.js";
import type {
  MessageInfo,
  ParticipantInfo,
  ParticipantView,
  RoomWaitResult,
  RoomWaitStatus,
} from "./types.js";

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Default hold. Long on purpose: every return costs a model inference, so a
 * short poll loop burns tokens even when the room is silent. Tune per client
 * with AI_ROOM_WAIT_MS — keep it below that client's hard per-call timeout.
 */
export const DEFAULT_WAIT_MS = envMs("AI_ROOM_WAIT_MS", 90_000);
/**
 * Hosts move a slow tool call off the foreground turn — Claude Code does it at
 * 120s — and the model then keeps working while the call it abandoned is the
 * only thing left listening. A default under that budget keeps a waiting agent
 * genuinely waiting: the hold ends, the agent calls again, and the room always
 * has a live waiter to wake. Raise it only for a client known to hold longer.
 */
export const FOREGROUND_BUDGET_MS = 120_000;
/** Upper bound a caller may request. */
export const MAX_WAIT_MS = 1_500_000;
/**
 * Progress cadence. Default sits well under Claude Code's 300_000ms idle
 * timeout for http MCP servers. Tune with AI_ROOM_HEARTBEAT_MS.
 */
export const HEARTBEAT_MS = envMs("AI_ROOM_HEARTBEAT_MS", 20_000);
/**
 * How old a self-reported status may be before the monitor stops presenting it
 * as current. Only used for display: the server never rewrites a status it did
 * not observe.
 */
export const STATUS_STALE_MS = envMs("AI_ROOM_STALE_MS", 120_000);

// None of these may end in "call room_wait again": that instruction is what
// turned an empty room into a paid polling loop. Holding a wait costs a model
// turn every time the harness cuts it short, so with nothing to do the answer
// is always room_idle — stop, and be resumed.
const NEXT_ACTION_MESSAGES =
  "Process every message now and do the work. When you have finished and nothing is left, call room_idle and end your turn.";
const NEXT_ACTION_TIMEOUT =
  "No messages arrived. If your role still has unfinished work, resume it now. Otherwise call room_idle with your wake target and end your turn — do not call room_wait again.";
const NEXT_ACTION_CANCELLED =
  "The wait was cancelled by the client and consumed nothing. Do not re-issue it: continue your work, or call room_idle and end your turn.";
const NEXT_ACTION_SUPERSEDED =
  "A newer room_wait for this agent took over; this one delivered nothing and consumed nothing. Stop this loop: do not call room_wait again from here.";

interface Subscription {
  promise: Promise<void>;
  cancel: () => void;
  /** True when a newer wait for the same (room, agent) took this one's place. */
  superseded: () => boolean;
}

interface Waiter {
  finish: () => void;
  superseded: boolean;
}

/**
 * Tracks live waits per (room, agent), not just per room. Keying by room alone
 * made "is this agent actually waiting?" unanswerable, so the monitor showed a
 * status the agent had published minutes earlier as if it were current.
 */
export class RoomWaitRegistry {
  private readonly rooms = new Map<string, Map<string, Set<Waiter>>>();

  /**
   * Resolves on the first of: a message in `room`, `timeoutMs` elapsing,
   * `signal` aborting, or a newer wait for the same agent superseding this one.
   * Aborting matters — without it a client that drops mid-wait leaves this
   * handler pending for the whole hold.
   */
  subscribe(
    room: string,
    agent: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Subscription {
    let settled = false;
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const waiter: Waiter = { finish: () => undefined, superseded: false };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      this.remove(room, agent, waiter);
      resolvePromise();
    };
    waiter.finish = finish;

    const agents = this.agents(room);
    const waiters = agents.get(agent) ?? new Set<Waiter>();
    waiters.add(waiter);
    agents.set(agent, waiters);
    const timer = setTimeout(finish, timeoutMs);

    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });

    return { promise, cancel: finish, superseded: () => waiter.superseded };
  }

  private agents(room: string): Map<string, Set<Waiter>> {
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const created = new Map<string, Set<Waiter>>();
    this.rooms.set(room, created);
    return created;
  }

  private remove(room: string, agent: string, waiter: Waiter): void {
    const agents = this.rooms.get(room);
    const waiters = agents?.get(agent);
    waiters?.delete(waiter);
    if (waiters && waiters.size === 0) agents?.delete(agent);
    if (agents && agents.size === 0) this.rooms.delete(room);
  }

  notify(room: string): void {
    const agents = this.rooms.get(room);
    if (!agents) return;
    for (const waiters of [...agents.values()]) {
      for (const waiter of [...waiters]) waiter.finish();
    }
  }

  /**
   * Single flight per (room, agent): a new wait replaces whatever that agent
   * had parked. Two live waits for one agent race over the same cursor, and
   * the loser's messages are delivered to a call nobody is reading any more —
   * which is exactly what a backgrounded wait becomes. The replaced wait
   * settles as "superseded" and consumes nothing.
   */
  supersede(room: string, agent: string): number {
    const waiters = this.rooms.get(room)?.get(agent);
    if (!waiters) return 0;
    const replaced = [...waiters];
    for (const waiter of replaced) {
      waiter.superseded = true;
      waiter.finish();
    }
    return replaced.length;
  }

  /** Objective liveness: this agent has a wait parked right now. */
  isWaiting(room: string, agent: string): boolean {
    return (this.rooms.get(room)?.get(agent)?.size ?? 0) > 0;
  }

  waitingAgents(room: string): string[] {
    return [...(this.rooms.get(room)?.keys() ?? [])];
  }

  size(): number {
    let count = 0;
    for (const agents of this.rooms.values()) {
      for (const waiters of agents.values()) count += waiters.size;
    }
    return count;
  }
}

/**
 * Decorates participant rows with the one thing only the registry knows. Kept
 * here so every caller — MCP room_who, the console feed, /active — reports the
 * same liveness instead of each inferring its own.
 */
export function withWaitLiveness(
  room: string,
  rows: (ParticipantInfo & { unread: number })[],
  registry: RoomWaitRegistry
): ParticipantView[] {
  return rows.map((row) => ({ ...row, waitActive: registry.isWaiting(room, row.agent) }));
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
  const NEXT_ACTION: Record<RoomWaitStatus, string> = {
    messages: NEXT_ACTION_MESSAGES,
    timeout: NEXT_ACTION_TIMEOUT,
    cancelled: NEXT_ACTION_CANCELLED,
    superseded: NEXT_ACTION_SUPERSEDED,
  };
  const settle = (messages: MessageInfo[], ended: RoomWaitStatus): RoomWaitResult => {
    const status = messages.length > 0 ? "messages" : ended;
    return {
      messages,
      status,
      waitedMs: Date.now() - startedAt,
      nextAction: NEXT_ACTION[status],
    };
  };

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

  // A client that is already gone must not consume: the first receive() below
  // advances the cursor, and its result would go nowhere.
  if (options.signal?.aborted) return settle([], "cancelled");

  // Single flight: whatever this agent had parked in this room stops here. A
  // wait the host moved to the background is still registered server-side, and
  // leaving it registered means a message can be handed to a call the model is
  // no longer reading.
  registry.supersede(params.room, params.agent);

  const pending = receive();
  if (pending.length > 0) return settle(pending, "messages");

  const subscription = registry.subscribe(
    params.room,
    params.agent,
    params.timeoutMs,
    options.signal
  );

  // Heartbeats also refresh last_seen_at, so a long-held waiter is not mistaken
  // for a dead agent by room_who or the /active endpoint.
  //
  // A timer callback has no caller to catch for it, so anything thrown here
  // reaches the top level and kills the server, taking every other room with
  // it. Both halves fail in normal operation — the room can be deleted under a
  // parked waiter, the notification channel can already be gone — and either
  // way this wait is over, so settle it and let the client get a response.
  const heartbeat = options.onHeartbeat
    ? setInterval(() => {
        try {
          const elapsed = Date.now() - startedAt;
          roomSetStatus(db, {
            room: params.room,
            agent: params.agent,
            status: "waiting",
            detail: null,
          });
          options.onHeartbeat?.(elapsed);
        } catch {
          clearInterval(heartbeat);
          subscription.cancel();
        }
      }, options.heartbeatMs ?? HEARTBEAT_MS)
    : undefined;

  try {
    const raced = receive();
    if (raced.length > 0) return settle(raced, "messages");
    await subscription.promise;

    // A cancelled or superseded wait must not consume anything. receive()
    // advances the read cursor, so draining here would hand messages to a call
    // nobody is reading any more and they would never reach anyone. This
    // happens for real: interrupting an agent's terminal aborts its in-flight
    // room_wait, and a host that backgrounds a slow call leaves the same hole.
    if (options.signal?.aborted) return settle([], "cancelled");
    if (subscription.superseded()) return settle([], "superseded");

    return settle(receive(), "timeout");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    subscription.cancel();
  }
}
