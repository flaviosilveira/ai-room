import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.js";
import { createHttpApp } from "../src/http.js";
import { TOOL_NAMES } from "../src/catalog.js";
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
    const healthResponse = await fetch(new URL("/health", baseUrl));
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      ok: true,
      version: "0.2.0",
      database: "ok",
    });

    const claude = await makeClient(baseUrl);
    const codex = await makeClient(baseUrl);
    const agy = await makeClient(baseUrl);

    await claude.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "claude" } });
    await codex.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "codex" } });
    await agy.callTool({ name: "room_join", arguments: { room: "backend-auth", agent: "agy" } });

    const tools = await claude.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["room_join", "room_listen", "room_wait", "room_list", "room_set_status"])
    );

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
    expect(codexListen[0]).toMatchObject({ origin: "agent" });

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

    const roomList = toolResult(
      await agy.callTool({ name: "room_list", arguments: { query: "backend auth" } })
    ) as Array<{ name: string }>;
    expect(roomList.map((room) => room.name)).toEqual(["backend-auth"]);

    await agy.callTool({
      name: "room_set_status",
      arguments: {
        room: "backend-auth",
        agent: "agy",
        status: "approval_required",
        detail: "Waiting for approval",
      },
    });

    const waiting = codex.callTool({
      name: "room_wait",
      arguments: { room: "backend-auth", agent: "codex", timeoutMs: 1_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await claude.callTool({
      name: "room_send",
      arguments: { room: "backend-auth", agent: "claude", message: "Final validation" },
    });
    const waitResult = toolResult(await waiting) as {
      status: string;
      messages: Array<{ content: string }>;
      nextAction: string;
    };
    expect(waitResult.status).toBe("messages");
    expect(waitResult.messages).toMatchObject([{ content: "Final validation" }]);
    expect(waitResult.nextAction).toMatch(/call room_wait again/i);

    const activeResponse = await fetch(new URL("/active?agent=codex", baseUrl));
    expect(activeResponse.status).toBe(200);
    const active = (await activeResponse.json()) as {
      active: boolean;
      rooms: Array<{ room: string; unread: number }>;
    };
    expect(active.active).toBe(true);
    expect(active.rooms.map((entry) => entry.room)).toEqual(["backend-auth"]);

    await codex.callTool({
      name: "room_leave",
      arguments: { room: "backend-auth", agent: "codex" },
    });
    const afterLeave = (await (
      await fetch(new URL("/active?agent=codex", baseUrl))
    ).json()) as { active: boolean };
    expect(afterLeave.active).toBe(false);

    const unknown = (await (
      await fetch(new URL("/active?agent=nobody", baseUrl))
    ).json()) as { active: boolean };
    expect(unknown.active).toBe(false);

    await claude.close();
    await codex.close();
    await agy.close();
  });

  it("keeps the published catalog identical to what the server registers", async () => {
    // This is what lets external tooling trust GET /tools and `ai-room tools`
    // instead of grepping registerTool out of the compiled server.
    const client = await makeClient(baseUrl);
    const registered = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(registered).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });

  it("serves capability discovery without an MCP handshake", async () => {
    const response = await fetch(new URL("/tools", baseUrl));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      count: number;
      tools: Array<{ name: string; summary: string; mutates: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(TOOL_NAMES.length);
    expect(body.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(body.tools.every((t) => t.summary.length > 0)).toBe(true);
  });
});
