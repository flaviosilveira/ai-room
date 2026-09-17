import type { RosterEntry } from "./types.js";

export interface OpenFlags {
  brief?: string;
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
    } else if (arg === "--dry-run") flags.dryRun = true;
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
    patch.roster = flags.invite.map((agent) => ({ agent, role: flags.roles.get(agent) }));
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
