import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  roomHistory,
  roomJoin,
  roomLeave,
  roomListen,
  roomSend,
  roomWho,
} from "./store.js";

export function createAiRoomServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: "ai-room",
    version: "1.0.0",
  });

  server.registerTool(
    "room_join",
    {
      description:
        "Join a room, identifying yourself as an agent. Creates the room if it doesn't exist.",
      inputSchema: {
        room: z.string().describe("Room name"),
        agent: z.string().describe("Agent identifier, e.g. claude, codex, agy"),
        role: z.string().optional().describe("Optional role, e.g. implementer, reviewer"),
      },
    },
    async ({ room, agent, role }) => {
      const result = roomJoin(db, { room, agent, role });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "room_send",
    {
      description: "Send a message to a room as the given agent.",
      inputSchema: {
        room: z.string(),
        agent: z.string(),
        message: z.string(),
      },
    },
    async ({ room, agent, message }) => {
      const result = roomSend(db, { room, agent, message });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "room_listen",
    {
      description:
        "Fetch messages from other agents in the room that this agent hasn't consumed yet. Advances this agent's read cursor.",
      inputSchema: {
        room: z.string(),
        agent: z.string(),
      },
    },
    async ({ room, agent }) => {
      const result = roomListen(db, { room, agent });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "room_history",
    {
      description:
        "Fetch chronological message history for a room, optionally filtered by agent or message id range.",
      inputSchema: {
        room: z.string(),
        limit: z.number().int().positive().optional(),
        after: z.number().int().optional(),
        before: z.number().int().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ room, limit, after, before, agent }) => {
      const result = roomHistory(db, { room, limit, after, before, agent });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "room_who",
    {
      description: "List known participants in a room and their last activity.",
      inputSchema: {
        room: z.string(),
      },
    },
    async ({ room }) => {
      const result = roomWho(db, { room });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "room_leave",
    {
      description: "Mark an agent as having left a room. History is preserved.",
      inputSchema: {
        room: z.string(),
        agent: z.string(),
      },
    },
    async ({ room, agent }) => {
      roomLeave(db, { room, agent });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    }
  );

  return server;
}
