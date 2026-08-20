import type Database from "better-sqlite3";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express } from "express";
import { createAiRoomServer } from "./server.js";
import { VERSION } from "./version.js";
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
