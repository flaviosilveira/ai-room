import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Server } from "node:http";
import { openDb } from "../src/db/index.js";
import { createHttpApp } from "../src/http.js";
import { roomJoin, roomSend, roomSetStatus, roomWho } from "../src/store.js";
import { RoomWaitRegistry, STATUS_STALE_MS, roomWait, withWaitLiveness } from "../src/wait.js";
import {
  DETACH_KEYS,
  HELP,
  closeConfirmed,
  closeFromConsole,
  renderParticipant,
  resolveAttachTarget,
} from "../src/console.js";
import { joinPrompt } from "../src/invite.js";
import {
  agentPane,
  detachWorkspace,
  focusPane,
  sessionName,
  startSession,
  detectMultiplexer,
  ensureWorkspace,
  killWorkspace,
  listTaggedPanes,
  sessionExists,
  workspaceName,
  workspacePanes,
} from "../src/session.js";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const spawnSyncTmux = (args: string[]): string =>
  `${spawnSync("tmux", args, { encoding: "utf8" }).stdout ?? ""}`.trim();

describe("monitor shows only what the server can observe", () => {
  let db: Database.Database;
  let registry: RoomWaitRegistry;

  beforeEach(() => {
    db = openDb(":memory:");
    registry = new RoomWaitRegistry();
    roomJoin(db, { room: "r", agent: "claude" });
    roomJoin(db, { room: "r", agent: "codex" });
  });
  afterEach(() => db.close());

  const view = (agent: string) =>
    withWaitLiveness("r", roomWho(db, { room: "r" }).filter((p) => p.agent === agent), registry)[0];

  it("marks a live wait as live", async () => {
    const pending = roomWait(db, registry, { room: "r", agent: "codex", timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(plain(renderParticipant(view("codex")))).toBe("codex:wait(live)");
    await pending;
  });

  it("flags a 'waiting' with no live wait instead of repeating it as fact", async () => {
    const controller = new AbortController();
    const pending = roomWait(
      db,
      registry,
      { room: "r", agent: "claude", timeoutMs: 60_000 },
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await pending;

    const rendered = plain(renderParticipant(view("claude")));
    expect(rendered).toMatch(/^claude:waiting\?\d+[smh]$/);
    expect(rendered).not.toBe("claude:waiting");
  });

  it("shows unread next to the agent that has not read", () => {
    roomSend(db, { room: "r", agent: "codex", message: "um" });
    roomSend(db, { room: "r", agent: "codex", message: "dois" });
    roomSetStatus(db, { room: "r", agent: "claude", status: "working" });
    expect(plain(renderParticipant(view("claude")))).toBe("claude:working unread:2");
    expect(plain(renderParticipant(view("codex")))).toBe("codex:working");
  });

  it("ages a self-reported status that nothing has refreshed", () => {
    roomSetStatus(db, { room: "r", agent: "claude", status: "working" });
    const now = Date.now() + STATUS_STALE_MS + 60_000;
    expect(plain(renderParticipant(view("claude"), now))).toMatch(/^claude:working·\d+m$/);
  });

  it("keeps the status line short", () => {
    roomSend(db, { room: "r", agent: "codex", message: "um" });
    const line = plain(renderParticipant(view("claude")));
    expect(line.length).toBeLessThan(40);
  });
});

describe("console commands", () => {
  it("teaches tmux's real detach keys", () => {
    // `Ctrl-b D` is choose-client: the chooser opens behind a repainting agent
    // TUI and the human sees nothing happen.
    expect(DETACH_KEYS).toContain("Ctrl-b d");
    expect(plain(HELP)).toContain("Ctrl-b d");
    expect(plain(HELP)).not.toMatch(/Ctrl-b D|Ctrl-B D|Ctrl-A D/);
  });

  it("documents /detach and /close", () => {
    expect(plain(HELP)).toMatch(/\/detach/);
    expect(plain(HELP)).toMatch(/\/close/);
  });

  it("requires an explicit confirmation word for /close", () => {
    expect(closeConfirmed([])).toBe(false);
    expect(closeConfirmed(["agora"])).toBe(false);
    expect(closeConfirmed(["sim"])).toBe(true);
    expect(closeConfirmed(["--confirm"])).toBe(true);
    expect(closeFromConsole("r", { confirmed: false, driver: null })).toEqual({
      status: "needs-confirmation",
    });
  });
});

describe("the room loop survives a human talking in the pane", () => {
  it("says so in the seed prompt", () => {
    const prompt = joinPrompt("r", "claude");
    expect(prompt).toMatch(/that is not leaving the room/i);
    expect(prompt).toMatch(/only when a human explicitly tells you to leave/i);
  });

  it("says so in the stop hook", () => {
    const hook = fs.readFileSync(new URL("../hooks/ai-room-stop-hook.py", import.meta.url), "utf8");
    expect(hook).not.toMatch(/via room_leave or a direct human instruction/);
    expect(hook).toMatch(/ordinary human message here is not that instruction/i);
  });
});

describe("MCP surfaces the observable view", () => {
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
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it("serves participants with unread and wait liveness", async () => {
    roomJoin(db, { room: "r", agent: "claude" });
    roomJoin(db, { room: "r", agent: "codex" });
    roomSend(db, { room: "r", agent: "codex", message: "oi" });

    const response = await fetch(new URL("/who?room=r", baseUrl));
    const body = (await response.json()) as {
      participants: Array<{ agent: string; unread: number; waitActive: boolean }>;
    };
    const claude = body.participants.find((p) => p.agent === "claude")!;
    expect(claude.unread).toBe(1);
    expect(claude.waitActive).toBe(false);
  });
});

const tmux = detectMultiplexer("tmux");
describe.skipIf(!tmux)("workspace commands against real tmux", () => {
  const room = `vitest-console-${process.pid}`;
  const session = workspaceName(room);
  const pane = (title: string) => ({ title, command: ["sh", "-c", "sleep 60"] });

  afterEach(() => {
    if (tmux) killWorkspace(tmux, session);
  });

  it("finds an agent's pane by its stable tag", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex"), pane("monitor")]);
    const tagged = listTaggedPanes(tmux!, session);
    expect(tagged.map((p) => p.agent).sort()).toEqual(["claude", "codex", "monitor"]);
    const claude = agentPane(tmux!, session, "claude");
    expect(claude).toMatch(/^%\d+$/);
    expect(agentPane(tmux!, session, "claude")).toBe(claude);
    expect(agentPane(tmux!, session, "nobody")).toBeNull();
  });

  it("resolves /attach to the agent's pane and focuses it", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex"), pane("monitor")]);

    const target = resolveAttachTarget(room, "codex", tmux!);
    expect(target.kind).toBe("pane");
    if (target.kind !== "pane") throw new Error("expected a pane");
    expect(focusPane(tmux!, target.paneId).ok).toBe(true);

    const active = spawnSyncTmux(["display-message", "-p", "-t", session, `#{${"@airoom_agent"}}`]);
    expect(active).toBe("codex");
  });

  it("still resolves to a per-agent session when there is no workspace pane", () => {
    const detached = sessionName(room, "agy");
    startSession(tmux!, detached, process.cwd(), ["sh", "-c", "sleep 60"]);
    try {
      expect(resolveAttachTarget(room, "agy", tmux!)).toEqual({ kind: "session", session: detached });
      expect(resolveAttachTarget(room, "nobody", tmux!)).toEqual({ kind: "missing" });
    } finally {
      killWorkspace(tmux!, detached);
    }
  });

  it("detaches without killing the workspace or its agents", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);
    // No client is attached in a test run, so detach-client has nothing to do —
    // what matters is that it never takes the session or its panes down.
    detachWorkspace(tmux!, session);
    expect(sessionExists(tmux!, session)).toBe(true);
    expect(workspacePanes(tmux!, session)).toEqual(["claude"]);
  });

  it("closes the workspace only after confirmation, through closeRoom", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);

    expect(closeFromConsole(room, { confirmed: false, driver: tmux })).toEqual({
      status: "needs-confirmation",
    });
    expect(sessionExists(tmux!, session)).toBe(true);

    const closed = closeFromConsole(room, { confirmed: true, driver: tmux });
    expect(closed).toMatchObject({ status: "closed" });
    expect(closed.status === "closed" && closed.sessions).toContain(session);
    expect(sessionExists(tmux!, session)).toBe(false);
  });
});
