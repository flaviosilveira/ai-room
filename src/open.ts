import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessFor } from "./invite.js";
import type { RosterEntry } from "./types.js";

export interface OpenFlags {
  brief?: string;
  reuse: boolean;
  convention?: string;
  tools: string[];
  invite: string[];
  roles: Map<string, string>;
  /** Who talks to the human: an agent, false for nobody, undefined to pick one. */
  lead?: string | false;
  dryRun: boolean;
  detached: boolean;
  monitor: boolean;
  files: boolean;
  /** Undecided until the defaults are applied; on unless someone says off. */
  mouse?: boolean;
  defaults: boolean;
}

/** More instances than this of one agent is almost always a typo that would burn tokens. */
export const MAX_INSTANCES = 5;

/**
 * "claude*3" or "claude:3" is three instances in total: claude, claude-2,
 * claude-3. Instances already listed count toward it and names are never
 * repeated, so "claude,claude*2" is claude and claude-2.
 */
export function expandInvite(entries: string[]): string[] {
  const agents: string[] = [];
  for (const entry of entries) {
    const match = /^(.+?)[*:](\d+)$/.exec(entry.trim());
    if (!match) {
      if (!agents.includes(entry.trim())) agents.push(entry.trim());
      continue;
    }
    const [, name, countText] = match;
    const count = Number(countText);
    if (count < 1 || count > MAX_INSTANCES) {
      throw new Error(`"${entry}": between 1 and ${MAX_INSTANCES} instances of one agent`);
    }
    const base = harnessFor(name);
    // n instances in total: those already listed count toward it.
    const already = agents.filter((agent) => harnessFor(agent) === base).length;
    for (let added = already, n = 1; added < count; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (agents.includes(candidate)) continue;
      agents.push(candidate);
      added += 1;
    }
  }
  return agents;
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
    files: true,

    defaults: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? "";
    if (arg === "--brief") flags.brief = value();
    else if (arg === "--convention") flags.convention = value();
    else if (arg === "--tool") flags.tools.push(...value().split(",").filter(Boolean));
    else if (arg === "--invite") flags.invite = expandInvite([...flags.invite, ...value().split(",").filter(Boolean)]);
    else if (arg === "--role") {
      const [agent, ...rest] = value().split("=");
      if (agent && rest.length) flags.roles.set(agent, rest.join("="));
    } else if (arg === "--reuse") flags.reuse = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--detached") flags.detached = true;
    else if (arg === "--no-monitor") flags.monitor = false;
    else if (arg === "--no-files") flags.files = false;
    else if (arg === "--lead") flags.lead = value();
    else if (arg === "--no-lead") flags.lead = false;
    else if (arg === "--no-defaults") flags.defaults = false;
    else if (arg === "--mouse") flags.mouse = true;
    else if (arg === "--no-mouse") flags.mouse = false;
    else throw new Error(`Unknown flag "${arg}"`);
  }
  return flags;
}

export interface OpenDefaults {
  tools?: string[];
  convention?: string;
  invite?: string[];
  mouse?: boolean;
  /** Harness preference for the lead, or false to never pick one. */
  lead?: string[] | false;
}

export function defaultsPath(): string {
  return process.env.AI_ROOM_CONFIG || path.join(os.homedir(), ".ai-room", "config.json");
}

/** `~/.ai-room/config.json` → `{"defaults": {"tools": [...], "convention": "...", "invite": [...]}}`. */
export function loadOpenDefaults(file = defaultsPath()): OpenDefaults {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { defaults?: OpenDefaults };
    const d = parsed.defaults ?? {};
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined;
    return {
      tools: list(d.tools),
      convention: typeof d.convention === "string" && d.convention ? d.convention : undefined,
      invite: list(d.invite),
      mouse: typeof d.mouse === "boolean" ? d.mouse : undefined,
      lead: d.lead === false ? false : list(d.lead),
    };
  } catch {
    return {};
  }
}

/**
 * The machine's defaults fill what a NEW room was not given. A room that
 * already exists keeps its own charter: reopening it must never rewrite it
 * with whatever the defaults say today.
 */
/**
 * Codex runs out of usage first, so it leads only when nobody else can. Order
 * is by harness; the first invited instance of the first harness wins.
 */
export const LEAD_PREFERENCE = ["claude", "agy", "codex"];

export const LEAD_ROLE = "lead";

export function isLead(role: string | undefined): boolean {
  return Boolean(role?.split(/,\s*/).includes(LEAD_ROLE));
}

export function pickLead(agents: string[], preference: string[] = LEAD_PREFERENCE): string | null {
  for (const harness of preference) {
    const agent = agents.find((candidate) => harnessFor(candidate) === harness);
    if (agent) return agent;
  }
  return agents.find((agent) => agent !== "human") ?? null;
}

/** The lead's role, keeping whatever else the agent was asked to be. */
export function withLeadRole(role: string | undefined): string {
  return role && !isLead(role) ? `${LEAD_ROLE}, ${role}` : role ?? LEAD_ROLE;
}

/**
 * A new room with several agents gets one lead, the only one who talks to the
 * human, and the convention that says how. Asked or picked; `--no-lead` or
 * `"lead": false` opts out, and a single agent needs no lead.
 */
export function assignLead(flags: OpenFlags, preference: string[] | false | undefined): OpenFlags {
  if (flags.lead === false || preference === false || flags.invite.length < 2) return flags;
  if ([...flags.roles.values()].some(isLead)) return withLeadConvention(flags);
  const lead = typeof flags.lead === "string" ? flags.lead : pickLead(flags.invite, preference ?? LEAD_PREFERENCE);
  if (!lead) return flags;
  const roles = new Map(flags.roles);
  roles.set(lead, withLeadRole(roles.get(lead)));
  return withLeadConvention({ ...flags, roles });
}

function withLeadConvention(flags: OpenFlags): OpenFlags {
  const presets = (flags.convention ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return presets.includes("lead") ? flags : { ...flags, convention: [...presets, "lead"].join(",") };
}

export function withDefaults(flags: OpenFlags, defaults: OpenDefaults, roomIsNew: boolean): OpenFlags {
  // The mouse is how this terminal is used, not part of a room's charter, so it
  // applies on every open. On by default: dragging copies to the clipboard, so
  // it no longer costs the terminal's own copy and paste.
  const mouse = flags.mouse ?? (flags.defaults ? defaults.mouse : undefined) ?? true;
  if (!roomIsNew) return { ...flags, mouse };
  if (!flags.defaults) return assignLead({ ...flags, mouse }, undefined);
  return assignLead(
    {
      ...flags,
      mouse,
      tools: flags.tools.length ? flags.tools : defaults.tools ?? [],
      convention: flags.convention ?? defaults.convention,
      invite: flags.invite.length ? flags.invite : defaults.invite ?? [],
    },
    defaults.lead
  );
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
