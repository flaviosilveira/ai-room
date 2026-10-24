import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { requestApproval } from "../src/approvals.js";
import { roomCharter, roomHistory, roomJoin, roomSetCharter } from "../src/store.js";
import { createWebApp } from "../src/web.js";

describe("web view", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;
  let cwd: string;
  const token = "test-token-123";
  const auth = { Authorization: `Bearer ${token}` };
  const write = { ...auth, "X-AI-Room": "1", "Content-Type": "application/json" };

  beforeAll(async () => {
    db = openDb(":memory:");
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-web-"));
    fs.mkdirSync(path.join(cwd, ".ai-room", "for-human", "r"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".ai-room", "for-human", "r", "report.md"), "# Report\n\nAll good.");
    fs.writeFileSync(path.join(cwd, "secret.txt"), "do not serve");
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomJoin(db, { room: "r", agent: "agy" });
    roomSetCharter(db, { room: "r", brief: "Fix it", cwd });
    await new Promise<void>((resolve) => {
      server = createWebApp(db, { token, serverPort: 1 }).listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => {
    server?.close();
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("asks for the token before anything else", async () => {
    expect((await fetch(`${base}/api/rooms`)).status).toBe(401);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('action="/login"');
  });

  it("trades the right token for a cookie, and refuses the wrong one", async () => {
    const wrong = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ token: "nope" }), redirect: "manual" });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
    expect(right.status).toBe(303);
    const cookie = right.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await fetch(`${base}/api/rooms`, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(200);
  });

  it("lists the rooms with what waits on the human", async () => {
    requestApproval(db, { room: "r", agent: "agy", action: "git push origin main", tier: "human" });
    const { rooms } = (await (await fetch(`${base}/api/rooms`, { headers: auth })).json()) as { rooms: { room: string; pending: number }[] };
    expect(rooms.find((r) => r.room === "r")).toMatchObject({ pending: 1 });
  });

  it("posts as the human, but only with the header no cross-site form can send", async () => {
    const forged = await fetch(`${base}/api/rooms/r/say`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    expect(forged.status).toBe(403);
    const sent = await fetch(`${base}/api/rooms/r/say`, { method: "POST", headers: write, body: JSON.stringify({ message: "@agy status?" }) });
    expect(sent.status).toBe(200);
    const last = roomHistory(db, { room: "r" }).at(-1);
    expect(last).toMatchObject({ agent: "human", origin: "human", content: "@agy status?", to: ["agy"] });
  });

  it("answers a request once", async () => {
    const { id } = requestApproval(db, { room: "r", agent: "agy", action: "az group create -n x", tier: "human" });
    const allowed = await fetch(`${base}/api/rooms/r/approvals/${id}`, { method: "POST", headers: write, body: JSON.stringify({ allow: true }) });
    expect(allowed.status).toBe(200);
    const again = await fetch(`${base}/api/rooms/r/approvals/${id}`, { method: "POST", headers: write, body: JSON.stringify({ allow: true }) });
    expect(again.status).toBe(400);
  });

  it("serves the room's reports and nothing outside their folder", async () => {
    expect(roomCharter(db, "r")?.cwd).toBe(cwd);
    const { files } = (await (await fetch(`${base}/api/rooms/r/reports`, { headers: auth })).json()) as { files: { name: string }[] };
    expect(files.map((f) => f.name)).toEqual(["report.md"]);
    expect(await (await fetch(`${base}/api/rooms/r/reports/report.md`, { headers: auth })).text()).toContain("All good.");
    expect((await fetch(`${base}/api/rooms/r/reports/..%2F..%2Fsecret.txt`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/rooms/nope/reports`, { headers: auth })).status).toBe(404);
  });
});

describe("quick tunnel", () => {
  it("starts once, reports the address, and stops", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-tunnel-"));
    const fake = path.join(home, "cloudflared");
    fs.writeFileSync(fake, '#!/bin/sh\necho "INF |  https://quiet-river-1234.trycloudflare.com  |" >&2\nexec sleep 30\n', { mode: 0o755 });
    const previous = process.env.AI_ROOM_HOME;
    process.env.AI_ROOM_HOME = home;
    try {
      const { startTunnel, stopTunnel, tunnelStatus } = await import("../src/web.js");
      const started = await startTunnel(fake, 5000);
      expect(started.url).toBe("https://quiet-river-1234.trycloudflare.com");
      expect((await startTunnel(fake, 5000)).pid).toBe(started.pid);
      expect(tunnelStatus()?.url).toBe(started.url);
      expect(stopTunnel()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(tunnelStatus()).toBeNull();
    } finally {
      process.env.AI_ROOM_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("web view: knowledge", () => {
  it("shows the room's base and lets the human decide on updates", async () => {
    const { readKnowledge, proposeKnowledge, knowledgeSections } = await import("../src/knowledge.js");
    const db = openDb(":memory:");
    roomJoin(db, { room: "k", agent: "human" });
    roomJoin(db, { room: "k", agent: "claude", role: "lead" });
    readKnowledge(db, "k", "claude", "acme");
    const proposal = proposeKnowledge(db, { room: "k", agent: "claude", section: "Stack", body: "Node and SQLite." });
    let server!: Server;
    await new Promise<void>((resolve) => {
      server = createWebApp(db, { token: "t", serverPort: 1 }).listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const view = (await (await fetch(`${base}/api/rooms/k/knowledge`, { headers: { Authorization: "Bearer t" } })).json()) as { project: string; pending: unknown[] };
      expect(view).toMatchObject({ project: "acme", pending: [{ id: proposal.id }] });
      const decided = await fetch(`${base}/api/knowledge/${proposal.id}`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "X-AI-Room": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ approve: true }),
      });
      expect(decided.status).toBe(200);
      expect(knowledgeSections(db, "acme")[0].body).toBe("Node and SQLite.");
    } finally {
      server.close();
      db.close();
    }
  });
});
