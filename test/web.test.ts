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

describe("web view: attachments and new rooms", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;
  let home: string;
  let previousDir: string | undefined;
  const launched: { argv: string[]; cwd: string }[] = [];
  const auth = { Authorization: "Bearer t" };
  const write = { ...auth, "X-AI-Room": "1" };
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex"
  );

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-webnew-"));
    previousDir = process.env.AI_ROOM_ATTACHMENT_DIR;
    process.env.AI_ROOM_ATTACHMENT_DIR = path.join(home, "attachments");
    db = openDb(":memory:");
    roomJoin(db, { room: "a", agent: "human", role: "host" });
    roomJoin(db, { room: "a", agent: "claude", role: "lead" });
    roomSetCharter(db, { room: "a", brief: "x", cwd: home });
    // Stands in for `ai-room open`: records what it was asked and writes the charter.
    const launch = (argv: string[], cwd: string) => {
      launched.push({ argv, cwd });
      const room = argv[1];
      if (argv.includes("fail")) return { exited: Promise.resolve(2) };
      setTimeout(() => {
        roomJoin(db, { room, agent: "human", role: "host" });
        roomSetCharter(db, { room, brief: argv[argv.indexOf("--brief") + 1], cwd });
      }, 50);
      return { exited: new Promise<number | null>(() => undefined) };
    };
    await new Promise<void>((resolve) => {
      server = createWebApp(db, { token: "t", serverPort: 1, launch, logDir: home, createWaitMs: 2000 }).listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => {
    server?.close();
    db.close();
    if (previousDir === undefined) delete process.env.AI_ROOM_ATTACHMENT_DIR;
    else process.env.AI_ROOM_ATTACHMENT_DIR = previousDir;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("stores a pasted image, sends it with the message and serves it back", async () => {
    const forged = await fetch(`${base}/api/rooms/a/attachments?name=shot.png`, { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: PNG });
    expect(forged.status).toBe(403);
    const up = await fetch(`${base}/api/rooms/a/attachments?name=shot.png`, { method: "POST", headers: { ...write, "Content-Type": "image/png" }, body: PNG });
    expect(up.status).toBe(200);
    const { attachment } = (await up.json()) as { attachment: { id: string; mime: string; width: number } };
    expect(attachment).toMatchObject({ mime: "image/png", width: 1 });

    const sent = await fetch(`${base}/api/rooms/a/say`, {
      method: "POST",
      headers: { ...write, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "", attachmentIds: [attachment.id] }),
    });
    expect(sent.status).toBe(200);
    expect(roomHistory(db, { room: "a" }).at(-1)?.attachments?.[0]?.id).toBe(attachment.id);

    const served = await fetch(`${base}/api/rooms/a/attachments/${attachment.id}`, { headers: auth });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${base}/api/rooms/a/attachments/att_nope`, { headers: auth })).status).toBe(404);
  });

  it("refuses an attachment id from nowhere and an unsupported file", async () => {
    const bad = await fetch(`${base}/api/rooms/a/say`, {
      method: "POST",
      headers: { ...write, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", attachmentIds: ["att_0000"] }),
    });
    expect(bad.status).toBe(400);
    const binary = await fetch(`${base}/api/rooms/a/attachments`, { method: "POST", headers: { ...write, "Content-Type": "application/octet-stream" }, body: Buffer.from([0, 1, 2, 3]) });
    expect(binary.status).toBe(400);
  });

  it("offers the folders earlier rooms used", async () => {
    const body = (await (await fetch(`${base}/api/new-room`, { headers: auth })).json()) as { folders: string[] };
    expect(body.folders).toContain(home);
  });

  it("creates a room through ai-room open, in the chosen folder", async () => {
    const created = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { ...write, "Content-Type": "application/json" },
      body: JSON.stringify({ room: "nova-sala", brief: "Do it", cwd: home, invite: ["claude", "codex"], knowledge: "acme" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, room: "nova-sala" });
    expect(launched.at(-1)).toEqual({
      argv: ["open", "nova-sala", "--new", "--brief", "Do it", "--invite", "claude,codex", "--kb", "acme"],
      cwd: home,
    });
    expect(roomCharter(db, "nova-sala")?.brief).toBe("Do it");
  });

  it("validates before launching anything", async () => {
    const post = (body: object) =>
      fetch(`${base}/api/rooms`, { method: "POST", headers: { ...write, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const count = launched.length;
    expect((await post({ room: "a", brief: "x", cwd: home })).status).toBe(409);
    expect((await post({ room: "bad name", brief: "x", cwd: home })).status).toBe(400);
    expect((await post({ room: "ok", brief: "x", cwd: path.join(home, "missing") })).status).toBe(400);
    expect((await post({ room: "ok", brief: "x", cwd: home, invite: ["rm -rf"] })).status).toBe(400);
    expect(launched.length).toBe(count);
    const failed = await post({ room: "fail", brief: "x", cwd: home });
    expect(failed.status).toBe(500);
  });

  it("needs only a name, like ai-room open", async () => {
    const created = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { ...write, "Content-Type": "application/json" },
      body: JSON.stringify({ room: "so-nome" }),
    });
    expect(created.status).toBe(200);
    expect(launched.at(-1)).toEqual({ argv: ["open", "so-nome", "--new"], cwd: home });
  });

  it("starts a room's agents with ai-room open, in the room's folder", async () => {
    const started = await fetch(`${base}/api/rooms/a/start`, { method: "POST", headers: write });
    expect(started.status).toBe(200);
    expect(launched.at(-1)).toEqual({ argv: ["open", "a"], cwd: home });
  });

  it("reads a Windows path the way WSL sees it", async () => {
    const { hostPath } = await import("../src/web.js");
    expect(hostPath("C:\\dev\\personal\\ai-room", "linux")).toBe("/mnt/c/dev/personal/ai-room");
    expect(hostPath("D:/x/", "linux")).toBe("/mnt/d/x");
    expect(hostPath("C:\\dev", "win32")).toBe("C:\\dev");
    expect(hostPath("/home/me", "linux")).toBe("/home/me");
  });
});

describe("web view: what the agents are doing", () => {
  it("streams each pane's reading and shows one agent's screen", async () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "l", agent: "human" });
    roomJoin(db, { room: "l", agent: "claude", role: "lead" });
    const live = (room: string) => (room === "l" ? [{ agent: "claude", state: "working" as const, label: "Cogitating", elapsed: "25s", stillForMs: 0 }] : null);
    const screen = (room: string, agent: string, lines: number) => (room === "l" && agent === "claude" ? `✻ Cogitating… (25s)\nlines=${lines}` : null);
    let server!: Server;
    await new Promise<void>((resolve) => {
      server = createWebApp(db, { token: "t", serverPort: 1, live, screen }).listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const auth = { Authorization: "Bearer t" };
    try {
      const shown = (await (await fetch(`${base}/api/rooms/l/screen/claude?lines=40`, { headers: auth })).json()) as { text: string };
      expect(shown.text).toBe("✻ Cogitating… (25s)\nlines=40");
      expect((await fetch(`${base}/api/rooms/l/screen/codex`, { headers: auth })).status).toBe(404);

      const controller = new AbortController();
      const events = await fetch(`${base}/api/rooms/l/events`, { headers: auth, signal: controller.signal });
      const reader = events.body!.getReader();
      let text = "";
      while (!text.includes("event: live")) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      const data = JSON.parse(text.split("event: live\ndata: ")[1].split("\n")[0]) as { agents: { agent: string; label: string }[] };
      expect(data.agents[0]).toMatchObject({ agent: "claude", state: "working", label: "Cogitating" });
    } finally {
      server.close();
      db.close();
    }
  });
});

describe("web view: the terminal's own status line", () => {
  it("picks the line the harness prints, as it prints it", async () => {
    const { statusLine } = await import("../src/web.js");
    expect(statusLine("Avisei na sala e voltei a ficar idle.\n\n✻ Worked for 25s · done 8:10 AM\n\n❯ \n  ⏵⏵ auto mode on")).toBe("✻ Worked for 25s · done 8:10 AM");
    expect(statusLine("Read the message.\n\n* Cogitated for 6s · done 8:10 AM\n❯")).toBe("* Cogitated for 6s · done 8:10 AM");
    expect(statusLine("● Reading files\n✶ Flambéing… (2m 3s · ↓ 4.1k tokens · esc to interrupt)\n❯")).toBe("✶ Flambéing… (2m 3s · ↓ 4.1k tokens · esc to interrupt)");
    expect(statusLine("• Working (12s • esc to interrupt)")).toBe("• Working (12s • esc to interrupt)");
    expect(statusLine("Bash(git push)\n Do you want to proceed?\n ❯ 1. Yes")).toBe("Do you want to proceed?");
    expect(statusLine("just text\n❯")).toBeUndefined();
  });
});
