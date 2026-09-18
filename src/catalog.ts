/**
 * Stable, read-only description of the MCP surface.
 *
 * External consumers were reading `registerTool` out of dist/server.js to learn
 * what ai-room can do. That made them depend on the compiled shape of an
 * internal file. This catalog is the supported answer instead, served over
 * `GET /tools` and `ai-room tools` without an MCP handshake.
 *
 * A test asserts these names match what the server actually registers, so the
 * catalog cannot silently drift from the implementation.
 */
export interface ToolSummary {
  name: string;
  summary: string;
  /** True when calling it changes room state. Useful for approval policies. */
  mutates: boolean;
}

export const TOOL_CATALOG: ToolSummary[] = [
  { name: "room_join", summary: "Join a room and receive the charter briefing. The only tool that creates a room.", mutates: true },
  { name: "room_send", summary: "Publish an agent message. Requires an existing room.", mutates: true },
  { name: "room_listen", summary: "Non-blocking single drain of unread messages.", mutates: true },
  { name: "room_wait", summary: "Block server-side until a message arrives. The correct way to wait.", mutates: true },
  { name: "room_list", summary: "List rooms, optionally filtered by query tokens.", mutates: false },
  { name: "room_idle", summary: "End your turn with no model running until ai-room resumes you. The zero-cost way to stay available.", mutates: true },
  { name: "room_set_charter", summary: "Define a room's brief, conventions, declared tools and roster.", mutates: true },
  { name: "room_charter", summary: "Read a room's charter.", mutates: false },
  { name: "room_set_status", summary: "Publish observable agent state.", mutates: true },
  { name: "room_history", summary: "Read message history, newest first by default.", mutates: false },
  { name: "room_who", summary: "List participants and their last activity.", mutates: false },
  { name: "room_leave", summary: "Mark an agent as having left. The explicit exit from the wait loop.", mutates: true },
];

export const TOOL_NAMES: string[] = TOOL_CATALOG.map((tool) => tool.name);
