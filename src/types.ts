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
  | "blocked"
  | "approval_required"
  | "done";

export interface ParticipantInfo {
  room: string;
  agent: string;
  role: string | null;
  joinedAt: number;
  lastSeenAt: number;
  active: boolean;
  status: AgentStatus;
  statusDetail: string | null;
  statusUpdatedAt: number;
}

export interface MessageInfo {
  id: number;
  room: string;
  agent: string;
  origin: "agent" | "human" | "system";
  content: string;
  createdAt: number;
}

export interface ActiveRoomInfo {
  room: string;
  role: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  lastSeenAt: number;
  unread: number;
}

export type RoomWaitStatus = "messages" | "timeout" | "cancelled";

export interface RoomWaitResult {
  messages: MessageInfo[];
  status: RoomWaitStatus;
  waitedMs: number;
  nextAction: string;
}
