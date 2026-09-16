import type Database from "better-sqlite3";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Express } from "express";
import { createAiRoomServer } from "./server.js";
import { agentActiveRooms, roomHistory, roomSend, roomWho } from "./store.js";
import { VERSION } from "./version.js";
import { TOOL_CATALOG } from "./catalog.js";
import { RoomWaitRegistry } from "./wait.js";

export function createHttpApp(db: Database.Database): Express {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const startedAt = Date.now();
  const waitRegistry = new RoomWaitRegistry();

  app.get("/health", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({
        ok: true,
        name: "ai-room",
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        database: "ok",
        mcpEndpoint: "/mcp",
      });
    } catch {
      res.status(503).json({
        ok: false,
        name: "ai-room",
        version: VERSION,
        database: "error",
        mcpEndpoint: "/mcp",
      });
    }
  });

  // Polled by harness stop hooks to decide whether an agent may end its turn.
  // Deliberately unauthenticated and read-only: it is bound to 127.0.0.1 and
  // exposes nothing a local caller cannot already read from the SQLite file.
  app.get("/active", (req, res) => {
    const agent = typeof req.query.agent === "string" ? req.query.agent : "";
    if (!agent) {
      res.status(400).json({ ok: false, error: "query parameter 'agent' is required" });
      return;
    }
    try {
      const rooms = agentActiveRooms(db, agent);
      const room = typeof req.query.room === "string" ? req.query.room : undefined;
      const scoped = room ? rooms.filter((entry) => entry.room === room) : rooms;
      res.json({
        ok: true,
        agent,
        active: scoped.length > 0,
        unread: scoped.reduce((total, entry) => total + entry.unread, 0),
        rooms: scoped,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // The human channel. `origin` is set here, server-side, so an agent can never
  // claim to be the human: room_send over MCP always writes "agent".
  app.post("/say", express.json(), (req, res) => {
    const room = typeof req.body?.room === "string" ? req.body.room : "";
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const agent = typeof req.body?.agent === "string" ? req.body.agent : "human";
    if (!room || !message) {
      res.status(400).json({ ok: false, error: "room and message are required" });
      return;
    }
    try {
      const sent = roomSend(db, { room, agent, message, origin: "human" });
      // Wake every waiter immediately instead of letting them sit out the hold.
      waitRegistry.notify(room);
      res.json({ ok: true, message: sent });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Live feed for the console: replays recent history, then streams new
  // messages and participant status as they land.
  app.get("/stream", (req, res) => {
    const room = typeof req.query.room === "string" ? req.query.room : "";
    if (!room) {
      res.status(400).json({ ok: false, error: "query parameter 'room' is required" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const backlog = Number(req.query.backlog ?? 20);
    let lastId = 0;
    for (const message of roomHistory(db, { room, limit: Number.isFinite(backlog) ? backlog : 20 })) {
      send("message", message);
      lastId = Math.max(lastId, message.id);
    }

    let lastStatus = "";
    const poll = () => {
      try {
        const fresh = roomHistory(db, { room, after: lastId, limit: 200 });
        for (const message of fresh) {
          send("message", message);
          lastId = Math.max(lastId, message.id);
        }
        // Status is small and changes rarely; diffing it avoids a chatty stream.
        const participants = roomWho(db, { room });
        const fingerprint = JSON.stringify(
          participants.map((p) => [p.agent, p.status, p.statusDetail, p.active])
        );
        if (fingerprint !== lastStatus) {
          lastStatus = fingerprint;
          send("status", participants);
        }
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      }
    };

    poll();
    send("ready", { room });
    const timer = setInterval(poll, 700);
    // Comment frames keep proxies and idle timers from closing the stream.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);

    req.on("close", () => {
      clearInterval(timer);
      clearInterval(keepAlive);
      res.end();
    });
  });

  // Capability discovery without an MCP handshake, so external tooling never
  // has to inspect the compiled server to learn what ai-room offers.
  app.get("/tools", (_req, res) => {
    res.json({
      ok: true,
      name: "ai-room",
      version: VERSION,
      mcpEndpoint: "/mcp",
      count: TOOL_CATALOG.length,
      tools: TOOL_CATALOG,
    });
  });

  app.post("/mcp", async (req, res) => {
    const server = createAiRoomServer(db, waitRegistry);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  });

  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  });

  return app;
}
