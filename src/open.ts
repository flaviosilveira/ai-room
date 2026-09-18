import { harnessFor } from "./invite.js";
import type { RosterEntry } from "./types.js";

export interface OpenFlags {
  brief?: string;
  reuse: boolean;
  convention?: string;
  tools: string[];
  invite: string[];
  roles: Map<string, string>;
  dryRun: boolean;
  detached: boolean;
  monitor: boolean;
}

export function parseOpenFlags(argv: string[]): OpenFlags {
  const flags: OpenFlags = {
    reuse: false,
    tools: [],
    invite: [],
    roles: new Map(),
    dryRun: false,
    detached: false,
    monitor: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? "";
    if (arg === "--brief") flags.brief = value();
    else if (arg === "--convention") flags.convention = value();
    else if (arg === "--tool") flags.tools.push(...value().split(",").filter(Boolean));
    else if (arg === "--invite") flags.invite.push(...value().split(",").filter(Boolean));
    else if (arg === "--role") {
      const [agent, ...rest] = value().split("=");
      if (agent && rest.length) flags.roles.set(agent, rest.join("="));
    } else if (arg === "--reuse") flags.reuse = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--detached") flags.detached = true;
    else if (arg === "--no-monitor") flags.monitor = false;
    else throw new Error(`Unknown flag "${arg}"`);
  }
  return flags;
}

export interface CharterPatch {
  room: string;
  brief?: string | null;
  conventionPreset?: string | null;
  tools?: string[];
  roster?: RosterEntry[];
}

/**
 * Only the flags actually given become charter fields. Sending every field on
 * every run made a second `ai-room open <room>` — the reattach path — wipe the
 * brief, the tooling and the roster of the room it was supposed to reopen.
 */
export function charterPatch(room: string, flags: OpenFlags): CharterPatch {
  const patch: CharterPatch = { room };
  if (flags.brief !== undefined) patch.brief = flags.brief;
  if (flags.convention !== undefined) patch.conventionPreset = flags.convention;
  if (flags.tools.length) patch.tools = flags.tools;
  if (flags.invite.length) {
    patch.roster = flags.invite.map((agent) => ({
      agent,
      harness: harnessFor(agent),
      role: flags.roles.get(agent),
    }));
  }
  return patch;
}

/**
 * Reopening without --invite brings back the cast the charter already knows,
 * so a bare `ai-room open <room>` restores the workspace instead of attaching
 * to an empty one. The human is a participant, never a launchable harness.
 */
export function agentsToLaunch(flags: OpenFlags, roster: RosterEntry[]): string[] {
  if (flags.invite.length) return flags.invite;
  return roster.map((entry) => entry.agent).filter((agent) => agent !== "human");
}

export type ReuseVerdict =
  | { kind: "new" }
  | { kind: "reattach" }
  | { kind: "continue" }
  | { kind: "conflict"; messages: number; currentBrief: string | null };

/**
 * Whether `open` may write this brief over the room it found.
 *
 * Reopening a room by name is how you reattach, so it has to stay silent and
 * free. But a room carries a whole task: its history, its cursors and the
 * identities that read them. Dropping a different brief into one that already
 * has a conversation quietly merges two tasks — which is what happened when
 * OP-3406 was opened on top of OP-3604's room, and the agents had to argue
 * their way out of the old history.
 */
export function reuseVerdict(params: {
  roomExists: boolean;
  messages: number;
  currentBrief: string | null;
  newBrief?: string;
  reuse: boolean;
}): ReuseVerdict {
  if (!params.roomExists) return { kind: "new" };
  if (params.newBrief === undefined) return { kind: "reattach" };
  if (params.reuse) return { kind: "continue" };
  if (params.messages === 0) return { kind: "continue" };
  const same = (params.currentBrief ?? "").trim() === params.newBrief.trim();
  if (same) return { kind: "continue" };
  return { kind: "conflict", messages: params.messages, currentBrief: params.currentBrief };
}

export type JoinState = "joined" | "starting" | "join_failed";

export interface JoinReport {
  agent: string;
  harness: string;
  state: JoinState;
  waitedMs: number;
  detail?: string;
}

/**
 * Did the processes `open` started actually enter the room?
 *
 * Launching a pane is not joining: a harness can stop at its own directory
 * trust prompt, or fail to reach the server, and the workspace then looks
 * healthy while the room is empty. `open` waits a little and says which agents
 * made it, instead of leaving the human to discover it pane by pane.
 */
export function classifyJoins(
  launched: { agent: string; harness: string }[],
  joinedAgents: Set<string>,
  waitedMs: number,
  graceMs: number
): JoinReport[] {
  return launched.map(({ agent, harness }) => {
    if (joinedAgents.has(agent)) return { agent, harness, state: "joined" as const, waitedMs };
    return {
      agent,
      harness,
      state: waitedMs >= graceMs ? ("join_failed" as const) : ("starting" as const),
      waitedMs,
      detail:
        waitedMs >= graceMs
          ? "process started but never called room_join — check its pane for a trust or approval prompt"
          : undefined,
    };
  });
}
