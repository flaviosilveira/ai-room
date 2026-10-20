import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { decideApproval, pendingApprovals } from "./approvals.js";
import { approvePlan } from "./cast.js";
import { detectMultiplexer, sessionExists, workspaceName } from "./session.js";
import { mentionedAgents, roomCharter, roomExists, roomHistory, roomSend, roomWho } from "./store.js";
import { fileURLToPath } from "node:url";

/**
 * The web view of the rooms, for following and answering them away from the
 * terminal. It listens on its own port so that only it is ever exposed (a
 * Cloudflare Tunnel points here); the MCP endpoint and the console's /say stay
 * on 127.0.0.1 with no way in from outside. Every request needs the token in
 * ~/.ai-room/web-token, and every write a header no cross-site form can send.
 */
export const WEB_PORT = Number(process.env.AI_ROOM_WEB_PORT || 49376);
const PAGE = fileURLToPath(new URL("../web/index.html", import.meta.url));
const page = (loginError = "") => fs.readFileSync(PAGE, "utf8").replace("__LOGIN_ERROR__", loginError);
const COOKIE = "airoom_web";

export function webTokenPath(): string {
  return path.join(process.env.AI_ROOM_HOME || path.join(os.homedir(), ".ai-room"), "web-token");
}

export function webToken(rotate = false): string {
  const file = webTokenPath();
  if (!rotate) {
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      /* first run */
    }
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function presented(req: Request): string {
  const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (bearer) return bearer;
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : "";
}

const pendingCount = (db: Database.Database, room: string) => pendingApprovals(db, room).length;

function roomSummaries(db: Database.Database) {
  const rows = db
    .prepare(
      `SELECT r.name AS room, MAX(m.created_at) AS lastAt
       FROM rooms r LEFT JOIN messages m ON m.room = r.name
       GROUP BY r.name ORDER BY lastAt DESC LIMIT 60`
    )
    .all() as { room: string; lastAt: number | null }[];
  const tmux = detectMultiplexer("tmux");
  return rows.map(({ room, lastAt }) => {
    const charter = roomCharter(db, room);
    return {
      room,
      lastAt,
      live: Boolean(tmux && sessionExists(tmux, workspaceName(room))),
      brief: charter?.brief?.slice(0, 160) ?? null,
      agents: roomWho(db, { room })
        .filter((p) => p.active && p.agent !== "human")
        .map((p) => ({ agent: p.agent, role: p.role, status: p.status })),
      pending: pendingCount(db, room),
      plan: Boolean(charter?.proposal),
    };
  });
}

function reportsDir(db: Database.Database, room: string): string | null {
  const cwd = roomCharter(db, room)?.cwd;
  return cwd ? path.join(cwd, ".ai-room", "for-human") : null;
}

export function createWebApp(db: Database.Database, options: { token?: string; serverPort?: number } = {}): Express {
  const token = options.token ?? webToken();
  const serverPort = options.serverPort ?? Number(process.env.AI_ROOM_PORT || 49375);
  const app = express();
  app.disable("x-powered-by");

  // What a console write does on the main server: bring back whoever it was for.
  const wake = (room: string) =>
    void fetch(`http://127.0.0.1:${serverPort}/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    }).catch(() => undefined);

  app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const given = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!given || !same(given, token)) {
      res.status(401).type("html").send(page("Token inválido."));
      return;
    }
    const secure = req.headers["x-forwarded-proto"] === "https" || req.secure;
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`
    );
    res.redirect(303, "/");
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (same(presented(req), token)) return next();
    if (req.method === "GET" && !req.path.startsWith("/api/")) {
      res.status(401).type("html").send(page());
      return;
    }
    res.status(401).json({ ok: false, error: "token required" });
  });

  // A cross-site form can carry the cookie but never a custom header.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.headers["x-ai-room"] !== "1") {
      res.status(403).json({ ok: false, error: "missing X-AI-Room header" });
      return;
    }
    next();
  });

  app.get("/", (_req, res) => res.type("html").send(page()));

  app.get("/api/rooms", (_req, res) => res.json({ ok: true, rooms: roomSummaries(db) }));

  const known = (req: Request, res: Response): string | null => {
    const room = String(req.params.room);
    if (roomExists(db, room)) return room;
    res.status(404).json({ ok: false, error: `no room "${room}"` });
    return null;
  };

  app.get("/api/rooms/:room/events", (req, res) => {
    const room = known(req, res);
    if (!room) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let lastId = 0;
    let lastState = "";
    const tick = () => {
      try {
        const charter = roomCharter(db, room);
        const state = {
          participants: roomWho(db, { room }).filter((p) => p.agent !== "human"),
          approvals: pendingApprovals(db, room),
          proposal: charter?.proposal ?? null,
          brief: charter?.brief ?? null,
        };
        const fingerprint = JSON.stringify(state);
        if (fingerprint !== lastState) {
          lastState = fingerprint;
          send("state", state);
        }
        const fresh = lastId ? roomHistory(db, { room, after: lastId, limit: 200 }) : roomHistory(db, { room, limit: 60 });
        for (const message of fresh) {
          send("message", message);
          lastId = Math.max(lastId, message.id);
        }
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(timer);
      clearInterval(keepAlive);
      res.end();
    });
  });

  app.post("/api/rooms/:room/say", express.json(), (req, res) => {
    const room = known(req, res);
    if (!room) return;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ ok: false, error: "message is required" });
      return;
    }
    const sent = roomSend(db, { room, agent: "human", origin: "human", message, to: mentionedAgents(db, room, message) });
    wake(room);
    res.json({ ok: true, message: sent });
  });

  app.post("/api/rooms/:room/approvals/:id", express.json(), (req, res) => {
    const room = known(req, res);
    if (!room) return;
    const result = decideApproval(db, room, Number(req.params.id), req.body?.allow === true);
    if (result.ok) wake(room);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/rooms/:room/plan", (req, res) => {
    const room = known(req, res);
    if (!room) return;
    const result = approvePlan(db, room);
    if (result.ok) wake(room);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.get("/api/rooms/:room/reports", (req, res) => {
    const room = known(req, res);
    if (!room) return;
    const dir = reportsDir(db, room);
    let files: { name: string; bytes: number; modifiedAt: number }[] = [];
    try {
      files = dir
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
            .map((entry) => {
              const stat = fs.statSync(path.join(dir, entry.name));
              return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtimeMs };
            })
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
        : [];
    } catch {
      /* no reports folder yet */
    }
    res.json({ ok: true, files });
  });

  app.get("/api/rooms/:room/reports/:name", (req, res) => {
    const room = known(req, res);
    if (!room) return;
    const dir = reportsDir(db, room);
    const name = path.basename(String(req.params.name));
    const file = dir ? path.join(dir, name) : "";
    if (!dir || name !== req.params.name || !fs.existsSync(file) || fs.statSync(file).size > 2_000_000) {
      res.status(404).json({ ok: false, error: "no such report" });
      return;
    }
    res.type("text/plain; charset=utf-8").send(fs.readFileSync(file, "utf8"));
  });

  return app;
}
