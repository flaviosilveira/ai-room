import type Database from "better-sqlite3";
import { LAUNCHERS, harnessFor, launchProfile, openWorkspace } from "./invite.js";
import { detectMultiplexer, killWorkspace, mux, paneStates, sessionExists, sessionName, workspaceName } from "./session.js";
import { roomCharter, roomExists, roomLeave, roomSend, roomSetCharter, roomWho } from "./store.js";
import { LEAD_ROLE, MAX_INSTANCES, isLead, pickLead, withLeadRole } from "./open.js";
import type { RosterEntry } from "./types.js";

/**
 * Changing who is in a room while it runs. An agent that hit its usage limit
 * has to leave for real: out of the roster, so reopening does not relaunch it;
 * out of the participants, so nothing tries to wake it; and its pane gone. The
 * rest of the room is told, so someone picks up its part.
 */
const NOT_AGENTS = new Set(["human", "monitor", "files", "editor"]);

/**
 * Takes one agent out of the room for good: no longer a participant, so
 * nothing wakes it, and its pane or session closed. The roster is the caller's.
 */
export function retireAgent(db: Database.Database, room: string, agent: string): string {
  roomLeave(db, { room, agent });
  const tmux = detectMultiplexer("tmux");
  if (!tmux) return "no running pane";
  const workspace = workspaceName(room);
  const pane = sessionExists(tmux, workspace) ? paneStates(tmux, workspace).find((state) => state.agent === agent) : undefined;
  if (pane && mux(tmux, ["kill-pane", "-t", pane.paneId]).ok) {
    mux(tmux, ["select-layout", "-t", `=${workspace}:${pane.home}`, "tiled"]);
    return "pane closed";
  }
  return killWorkspace(tmux, sessionName(room, agent)) ? "session closed" : "no running pane";
}

/**
 * `open <room> --invite …` on a room that already has agents replaces its
 * cast: whoever is not in the new list leaves for real, and the room is told
 * who left and who came in. Returns who left.
 */
export function replaceCast(db: Database.Database, room: string, invite: string[]): string[] {
  const previous = new Set([
    ...(roomCharter(db, room)?.roster ?? []).map((entry) => entry.agent),
    ...roomWho(db, { room }).filter((p) => p.active).map((p) => p.agent),
  ]);
  const leaving = [...previous].filter((agent) => !NOT_AGENTS.has(agent) && !invite.includes(agent));
  const arriving = invite.filter((agent) => !previous.has(agent));
  if (!leaving.length && !arriving.length) return [];
  for (const agent of leaving) retireAgent(db, room, agent);
  const roster = roomCharter(db, room)?.roster;
  if (roster) roomSetCharter(db, { room, roster: roster.filter((entry) => !leaving.includes(entry.agent)) });
  roomSend(db, {
    room,
    agent: "human",
    origin: "human",
    message:
      "The human changed the cast of this room." +
      (leaving.length ? ` Left: ${leaving.join(", ")}.` : "") +
      (arriving.length ? ` Joining: ${arriving.join(", ")} — read room_history for what was already done.` : ""),
  });
  return leaving;
}

export function removeAgent(db: Database.Database, room: string, agent: string): { ok: boolean; detail: string } {
  if (!roomExists(db, room)) return { ok: false, detail: `no room "${room}"` };
  if (NOT_AGENTS.has(agent)) return { ok: false, detail: `"${agent}" is not an agent; hide it with Ctrl-b m instead` };

  const charter = roomCharter(db, room);
  const wasLead = isLead(charter?.roster.find((entry) => entry.agent === agent)?.role);
  let successor: string | null = null;
  if (charter?.roster.some((entry) => entry.agent === agent)) {
    let roster = charter.roster.filter((entry) => entry.agent !== agent);
    // The human keeps a single voice to talk to: the next agent by preference
    // takes the lead instead of the room falling back to everyone at once.
    if (wasLead) {
      successor = pickLead(roster.map((entry) => entry.agent));
      if (successor) roster = roster.map((entry) => (entry.agent === successor ? { ...entry, role: withLeadRole(entry.role) } : entry));
    }
    roomSetCharter(db, { room, roster });
  }
  const stopped = retireAgent(db, room, agent);

  roomSend(db, {
    room,
    agent: "human",
    origin: "human",
    message: `${agent} left the room (removed by the human). Whoever can, pick up its part of the work.` +
      (successor ? ` ${successor} is now the ${LEAD_ROLE}: the one who talks to the human.` : ""),
  });
  return { ok: true, detail: `${agent} removed: out of the roster and participants, ${stopped}` };
}

/**
 * The first free instance name for a harness. Names that ever joined count as
 * taken: a reused name would inherit the old instance's read cursor.
 */
export function nextInstanceName(taken: Set<string>, agent: string): string {
  const base = harnessFor(agent);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export type AddResult =
  | { ok: true; agent: string; detail: string }
  | { ok: false; detail: string; confirm?: string };

/**
 * Adding an agent that is already in the room means another instance, which
 * costs its own tokens; that is asked for explicitly (`confirmed`) and the
 * instance gets the next free number. An agent that was removed just returns.
 */
export function addAgent(
  db: Database.Database,
  room: string,
  requested: string,
  role?: string,
  options: { confirmed?: boolean } = {}
): AddResult {
  if (!roomExists(db, room)) return { ok: false, detail: `no room "${room}"` };
  const harness = harnessFor(requested);
  if (!LAUNCHERS[harness]) return { ok: false, detail: `no launcher for "${requested}". Known: ${Object.keys(LAUNCHERS).join(", ")}` };

  const tmux = detectMultiplexer("tmux");
  const workspace = workspaceName(room);
  const live = tmux && sessionExists(tmux, workspace);
  const panes = new Set(live ? paneStates(tmux, workspace).map((state) => state.agent) : []);
  const participants = roomWho(db, { room });
  const present = panes.has(requested) || participants.some((p) => p.agent === requested && p.active);

  let agent = requested;
  if (present) {
    const next = nextInstanceName(new Set([...panes, ...participants.map((p) => p.agent)]), requested);
    if (!options.confirmed) {
      return { ok: false, detail: `${requested} is already in the room; confirm to open ${next}`, confirm: next };
    }
    agent = next;
  }

  const roster = roomCharter(db, room)?.roster ?? [];
  const before = roster.find((e) => e.agent === agent);
  const entry = { ...before, agent, harness, role: role ?? before?.role, held: undefined };
  roomSetCharter(db, { room, roster: [...roster.filter((e) => e.agent !== agent), entry] });

  if (!live) return { ok: true, agent, detail: `${agent} added to the roster; it starts with: ai-room attach ${room}` };
  const { plan } = openWorkspace(room, [agent], { monitor: false, files: false, profiles: { [agent]: launchProfile(entry) } });
  if (plan.missing.length) return { ok: false, detail: `${LAUNCHERS[harness].bin} is not on PATH` };
  return { ok: true, agent, detail: `${agent} launched in a new pane` };
}

/** A team the human would not want: every member on a light model or effort. */
const LIGHT_MODEL = /haiku|mini|nano|lite|-low\b/i;

export function lightweight(entry: RosterEntry): boolean {
  return entry.effort === "low" || LIGHT_MODEL.test(entry.model ?? "");
}

/**
 * Checks the lead's plan before the human sees it. Two agents at least, since
 * the second point of view is the reason for a room; one alone is what the
 * human asks for by inviting one. Never everyone on a light setting.
 */
export function checkProposal(agents: RosterEntry[]): string | null {
  if (agents.length < 2) return "a plan needs at least two agents: the second point of view is the point of the room";
  for (const entry of agents) {
    if (!LAUNCHERS[harnessFor(entry.agent, entry.harness)]) return `no launcher for "${entry.agent}". Known: ${Object.keys(LAUNCHERS).join(", ")}`;
  }
  const perHarness = new Map<string, number>();
  for (const entry of agents) perHarness.set(harnessFor(entry.agent, entry.harness), (perHarness.get(harnessFor(entry.agent, entry.harness)) ?? 0) + 1);
  for (const [harness, count] of perHarness) if (count > MAX_INSTANCES) return `more than ${MAX_INSTANCES} instances of ${harness}`;
  if (agents.every(lightweight)) return "every agent is on a light model or effort; keep at least one at medium or above";
  return null;
}

export function proposePlan(
  db: Database.Database,
  room: string,
  by: string,
  plan: { size: string; reason?: string; plan?: string; agents: RosterEntry[] }
): { ok: boolean; detail: string } {
  const charter = roomCharter(db, room);
  if (!charter) return { ok: false, detail: `no charter for "${room}"` };
  if (!isLead(charter.roster.find((entry) => entry.agent === by)?.role)) {
    return { ok: false, detail: `only the lead proposes the team; ${by} is not the lead of ${room}` };
  }
  const agents = plan.agents.some((entry) => entry.agent === by)
    ? plan.agents
    : [{ agent: by }, ...plan.agents];
  const problem = checkProposal(agents);
  if (problem) return { ok: false, detail: problem };

  roomSetCharter(db, { room, proposal: { by, size: plan.size, reason: plan.reason, plan: plan.plan, agents, createdAt: Date.now() } });
  const lines = agents.map((entry) => {
    const level = [entry.model, entry.effort].filter(Boolean).join(" ") || "default level";
    return `- ${entry.agent}${entry.role ? ` (${entry.role})` : ""}: ${level}`;
  });
  roomSend(db, {
    room,
    agent: by,
    to: ["human"],
    message: [
      `Plan: ${plan.size}.${plan.reason ? ` ${plan.reason}` : ""}`,
      ...(plan.plan ? [`Decisions: ${plan.plan}`] : []),
      ...lines,
      "Approve with /approve, or change it with --model/--effort and /add.",
    ].join("\n"),
  });
  return { ok: true, detail: "proposed; the human approves it with /approve" };
}

/**
 * Applies the lead's plan (or, with none, just lets the held agents in) and
 * launches whoever it adds. Agents already running keep running: a new level
 * for one of them applies the next time it is launched.
 */
export function approvePlan(db: Database.Database, room: string): { ok: boolean; detail: string } {
  const charter = roomCharter(db, room);
  if (!charter) return { ok: false, detail: `no charter for "${room}"` };
  const proposal = charter.proposal;
  const current = new Map(charter.roster.map((entry) => [entry.agent, entry]));

  let roster: RosterEntry[];
  if (proposal) {
    const planned = proposal.agents.map((entry) => {
      const before = current.get(entry.agent);
      const role = isLead(before?.role) ? withLeadRole(entry.role ?? undefined) : entry.role ?? before?.role;
      return { ...before, ...entry, role, harness: entry.harness ?? before?.harness ?? harnessFor(entry.agent), held: undefined };
    });
    const kept = charter.roster.filter((entry) => !entry.held && !planned.some((p) => p.agent === entry.agent));
    roster = [...planned, ...kept];
  } else {
    if (!charter.roster.some((entry) => entry.held)) return { ok: false, detail: "no plan to approve and nobody waiting" };
    roster = charter.roster.map((entry) => ({ ...entry, held: undefined }));
  }
  roomSetCharter(db, { room, roster, proposal: null });

  const tmux = detectMultiplexer("tmux");
  const workspace = workspaceName(room);
  const live = tmux && sessionExists(tmux, workspace);
  const running = new Set(live ? paneStates(tmux, workspace).map((state) => state.agent) : []);
  const joining = roster.map((entry) => entry.agent).filter((agent) => !running.has(agent));
  const lead = roster.find((entry) => isLead(entry.role))?.agent;

  roomSend(db, {
    room,
    agent: "human",
    origin: "human",
    to: lead ? [lead] : undefined,
    message: `The human approved the plan.${proposal?.plan ? ` Decisions: ${proposal.plan}; read it before starting.` : ""}${joining.length ? ` Joining: ${joining.join(", ")}.` : ""}`,
  });
  if (!joining.length) return { ok: true, detail: "plan approved; everyone in it is already running" };
  if (!live) return { ok: true, detail: `plan approved; ${joining.join(", ")} start with: ai-room attach ${room}` };
  const profiles = Object.fromEntries(roster.map((entry) => [entry.agent, launchProfile(entry)]));
  const { plan } = openWorkspace(room, joining, { monitor: false, files: false, profiles });
  const missing = plan.missing.length ? `; not on PATH: ${plan.missing.join(", ")}` : "";
  return { ok: true, detail: `plan approved; launched ${plan.agents.join(", ") || "nobody"}${missing}` };
}
