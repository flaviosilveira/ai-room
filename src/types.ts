export interface RoomInfo {
  name: string;
  createdAt: number;
}

export interface RoomListInfo extends RoomInfo {
  lastActivityAt: number;
  participantCount: number;
  activeParticipantCount: number;
}

export type AgentStatus =
  | "waiting"
  | "working"
  /** Turn ended on purpose: no model is running and nothing polls. */
  | "idle"
  | "blocked"
  | "approval_required"
  | "done";

/**
 * How ai-room can reach a live agent session.
 *
 * `codex-queue` hands a notice to a Codex session through its own CLI.
 * `tmux-pane` types one into the pane a TUI harness is already living in —
 * the only way to reach a running Claude Code session, whose `--resume` starts
 * a copy instead of continuing the session that is on screen.
 */
export type WakeKind = "codex-queue" | "tmux-pane";

export interface WakeSpec {
  kind: WakeKind;
  id: string;
}

export interface ParticipantInfo {
  room: string;
  agent: string;
  /** Which CLI this instance runs; several instances may share one harness. */
  harness: string | null;
  role: string | null;
  joinedAt: number;
  lastSeenAt: number;
  active: boolean;
  status: AgentStatus;
  statusDetail: string | null;
  statusUpdatedAt: number;
  /** Set once the agent registers how it can be resumed while idle. */
  wake: WakeSpec | null;
  wakeError: string | null;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Absolute path of the stored file; null once pruned. */
  path: string | null;
  createdAt: number;
}

export interface MessageInfo {
  id: number;
  room: string;
  agent: string;
  origin: "agent" | "human" | "system";
  content: string;
  createdAt: number;
  /** Present only when the message has attachments, so older readers see what they always did. */
  attachments?: AttachmentInfo[];
}

/**
 * A participant as the server can actually observe it: the status the agent
 * last published, plus the two facts the server knows first-hand — whether a
 * room_wait is parked for it right now, and how many messages it has not read.
 * `status` alone is a claim; `waitActive` is evidence.
 */
export interface ParticipantView extends ParticipantInfo {
  unread: number;
  waitActive: boolean;
}

/**
 * What the monitor is allowed to claim, and where each answer comes from:
 * `working`, `blocked` and `approval_required` are the agent's own report;
 * `idle` is its report plus a registered wake target; `wait(live)` and
 * `unread` are the server's own observations; `offline`/`finished` come from
 * participation. Nothing here is inferred from terminal output — no harness
 * exposes "the model is running right now" to ai-room.
 */
export type MonitorState =
  | "working"
  | "wait_live"
  | "idle"
  | "blocked"
  | "approval_required"
  | "wake_failed"
  | "offline"
  | "finished";

export interface ActiveRoomInfo {
  room: string;
  role: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  lastSeenAt: number;
  unread: number;
  /** 1 when the agent left a way to be resumed, so ending the turn is safe. */
  wakeRegistered: number;
}

export type RoomWaitStatus = "messages" | "timeout" | "cancelled" | "superseded";

export interface RoomWaitResult {
  messages: MessageInfo[];
  status: RoomWaitStatus;
  waitedMs: number;
  nextAction: string;
}

export interface RosterEntry {
  /** Instance identity in the room: "claude", "claude-2", "reviewer-codex". */
  agent: string;
  /** Which CLI runs it. Defaults to the agent name when it names a launcher. */
  harness?: string;
  role?: string;
  instructions?: string;
}

export interface ToolDeclaration {
  name: string;
  purpose?: string;
  howToUse?: string;
}

export interface RoomCharter {
  room: string;
  brief: string | null;
  conventions: string | null;
  conventionPreset: string | null;
  tools: ToolDeclaration[];
  roster: RosterEntry[];
  createdAt: number;
  updatedAt: number;
}

/** The charter as delivered to one specific agent on join. */
export interface AgentBriefing extends RoomCharter {
  you: RosterEntry | null;
  teammates: RosterEntry[];
}
