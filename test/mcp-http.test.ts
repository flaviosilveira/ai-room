import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.js";
import { createHttpApp } from "../src/http.js";
import type Database from "better-sqlite3";

async function makeClient(baseUrl: URL): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(baseUrl);
  await client.connect(transport);
  return client;
}

function toolResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text ?? "null";
  return JSON.parse(text);
}

describe("ai-room MCP over Streamable HTTP", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    db = openDb(":memory:");
    const app = createHttpApp(db);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it("supports the Claude -> Codex/AGY validation flow over real MCP tool calls", async () => {
    const claude = await makeClient(baseUrl);
    const codex = await makeClient(baseUrl);
    const agy = await makeClient(baseUrl);

    await claude.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "claude" } });
    await codex.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "codex" } });
    await agy.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "agy" } });

    await claude.callTool({
      name: "room_send",
      arguments: {
        room: "backend-auth",
        agent: "claude",
        message: "Fixed the race condition in refreshToken().",
      },
    });

    const codexListen = toolResult(
      await codex.callTool({ name: "room_listen", arguments: { room: "backend-auth", agent: "codex" } })
    ) as Array<{ agent: string; content: string }>;
    expect(codexListen).toHaveLength(1);
    expect(codexListen[0].agent).toBe("claude");

    await codex.callTool({
      name: "room_send",
      arguments: {
        room: "backend-auth",
        agent: "codex",
        message: "Review: risk of deadlock in X.",
      },
    });

    const agyHistory = toolResult(
      await agy.callTool({ name: "room_history", arguments: { room: "backend-auth" } })
    ) as Array<{ agent: string }>;
    expect(agyHistory.map((m) => m.agent)).toEqual(["claude", "codex"]);

    await claude.close();
    await codex.close();
    await agy.close();
  });
});
