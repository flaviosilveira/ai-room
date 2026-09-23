import type Database from "better-sqlite3";
import { LAUNCHERS, harnessFor, openWorkspace } from "./invite.js";
import { detectMultiplexer, killWorkspace, mux, paneStates, sessionExists, sessionName, workspaceName } from "./session.js";
import { roomCharter, roomExists, roomLeave, roomSend, roomSetCharter } from "./store.js";

/**
 * Changing who is in a room while it runs. An agent that hit its usage limit
 * has to leave for real: out of the roster, so reopening does not relaunch it;
 * out of the participants, so nothing tries to wake it; and its pane gone. The
 * rest of the room is told, so someone picks up its part.
 */
const NOT_AGENTS = new Set(["human", "monitor", "files"]);

export function removeAgent(db: Database.Database, room: string, agent: string): { ok: boolean; detail: string } {
  if (!roomExists(db, room)) return { ok: false, detail: `no room "${room}"` };
  if (NOT_AGENTS.has(agent)) return { ok: false, detail: `"${agent}" is not an agent; hide it with Ctrl-b m instead` };

  const charter = roomCharter(db, room);
  if (charter?.roster.some((entry) => entry.agent === agent)) {
    roomSetCharter(db, { room, roster: charter.roster.filter((entry) => entry.agent !== agent) });
  }
  roomLeave(db, { room, agent });

  let stopped = "no running pane";
  const tmux = detectMultiplexer("tmux");
  if (tmux) {
    const workspace = workspaceName(room);
    const pane = sessionExists(tmux, workspace) ? paneStates(tmux, workspace).find((state) => state.agent === agent) : undefined;
    if (pane && mux(tmux, ["kill-pane", "-t", pane.paneId]).ok) {
      mux(tmux, ["select-layout", "-t", `=${workspace}:${pane.home}`, "tiled"]);
      stopped = "pane closed";
    } else if (killWorkspace(tmux, sessionName(room, agent))) {
      stopped = "session closed";
    }
  }

  roomSend(db, {
    room,
    agent: "human",
    origin: "human",
    message: `${agent} left the room (removed by the human). Whoever can, pick up its part of the work.`,
  });
  return { ok: true, detail: `${agent} removed: out of the roster and participants, ${stopped}` };
}

export function addAgent(
  db: Database.Database,
  room: string,
  agent: string,
  role?: string
): { ok: boolean; detail: string } {
  if (!roomExists(db, room)) return { ok: false, detail: `no room "${room}"` };
  const harness = harnessFor(agent);
  if (!LAUNCHERS[harness]) return { ok: false, detail: `no launcher for "${agent}". Known: ${Object.keys(LAUNCHERS).join(", ")}` };

  const roster = roomCharter(db, room)?.roster ?? [];
  const entry = { agent, harness, role: role ?? roster.find((e) => e.agent === agent)?.role };
  roomSetCharter(db, { room, roster: [...roster.filter((e) => e.agent !== agent), entry] });

  const tmux = detectMultiplexer("tmux");
  if (!tmux || !sessionExists(tmux, workspaceName(room))) {
    return { ok: true, detail: `${agent} added to the roster; it starts with: ai-room attach ${room}` };
  }
  const { plan, result } = openWorkspace(room, [agent], { monitor: false, files: false });
  if (plan.missing.length) return { ok: false, detail: `${LAUNCHERS[harness].bin} is not on PATH` };
  return {
    ok: true,
    detail: result.panes.length ? `${agent} launched in a new pane` : `${agent} already has a pane`,
  };
}
