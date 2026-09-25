import type Database from "better-sqlite3";
import { LAUNCHERS, harnessFor, openWorkspace } from "./invite.js";
import { detectMultiplexer, killWorkspace, mux, paneStates, sessionExists, sessionName, workspaceName } from "./session.js";
import { roomCharter, roomExists, roomLeave, roomSend, roomSetCharter, roomWho } from "./store.js";
import { LEAD_ROLE, isLead, pickLead, withLeadRole } from "./open.js";

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
  const entry = { agent, harness, role: role ?? roster.find((e) => e.agent === agent)?.role };
  roomSetCharter(db, { room, roster: [...roster.filter((e) => e.agent !== agent), entry] });

  if (!live) return { ok: true, agent, detail: `${agent} added to the roster; it starts with: ai-room attach ${room}` };
  const { plan } = openWorkspace(room, [agent], { monitor: false, files: false });
  if (plan.missing.length) return { ok: false, detail: `${LAUNCHERS[harness].bin} is not on PATH` };
  return { ok: true, agent, detail: `${agent} launched in a new pane` };
}
