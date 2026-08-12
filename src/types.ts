export interface RoomInfo {
  name: string;
  createdAt: number;
}

export interface ParticipantInfo {
  room: string;
  agent: string;
  role: string | null;
  joinedAt: number;
  lastSeenAt: number;
  active: boolean;
}

export interface MessageInfo {
  id: number;
  room: string;
  agent: string;
  content: string;
  createdAt: number;
}
