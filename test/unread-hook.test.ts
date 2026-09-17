import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomJoin, roomListen, roomSend, roomWho } from "../src/store.js";
import {
  CODEX_TRUST_NOTE,
  UNREAD_HOOK,
  UNREAD_HOOK_PY,
  hookCommand,
  hookPath,
  hookSnippet,
  hookStatus,
} from "../src/hooks.js";

/**
 * The server has to be its own process: the hook is spawned synchronously, and
 * a synchronous spawn blocks this process's event loop, so an in-process server
 * could never answer the very request under test.
 */
async function startServer(dbPath: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 49_500 + Math.floor(Math.random() * 400);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src", "cli.ts"), "serve"],
    { env: { ...process.env, AI_ROOM_DB_PATH: dbPath, AI_ROOM_PORT: String(port) }, stdio: "ignore" }
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("ai-room server did not start");
}

const HOOK = hookPath(UNREAD_HOOK);

interface HookRun {
  stdout: string;
  status: number | null;
  context: string | null;
}

function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string> = {}
): HookRun {
  // The wrapper is what gets installed, so every case runs the real chain:
  // wrapper decides, Python does the work.
  const result = spawnSync(HOOK, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const stdout = `${result.stdout ?? ""}`.trim();
  let context: string | null = null;
  if (stdout) {
    try {
      context =
        (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? null;
    } catch {
      context = null;
    }
  }
  return { stdout, status: result.status, context };
}

const preToolUse = (tool = "Bash") => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  session_id: "s-1",
  cwd: process.cwd(),
  tool_input: {},
});

describe("unread boundary hook", () => {
  let db: Database.Database;
  let child: ChildProcess;
  let port: number;
  let workDir: string;
  let logDir: string;
  let env: Record<string, string>;
  let room: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-hook-"));
    const started = await startServer(path.join(workDir, "hook.sqlite"));
    child = started.child;
    port = started.port;
    db = openDb(path.join(workDir, "hook.sqlite"));
  }, 30_000);

  afterAll(() => {
    db.close();
    child.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // One room per test: the server process shares this file, so nothing may
    // leak between cases.
    room = `r-${Math.random().toString(36).slice(2, 8)}`;
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-hooklog-"));
    env = {
      AI_ROOM_PORT: String(port),
      AI_ROOM_HOOK_LOG: path.join(logDir, "unread-hook.jsonl"),
      AI_ROOM_ROOM: room,
      AI_ROOM_AGENT: "claude",
    };
    roomJoin(db, { room, agent: "claude" });
    roomJoin(db, { room, agent: "codex" });
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("says nothing when there is nothing unread", () => {
    const run = runHook(preToolUse(), env);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(fs.existsSync(path.join(logDir, "unread-hook.jsonl"))).toBe(false);
  });

  it("injects a short notice when messages are pending", () => {
    roomSend(db, { room, agent: "codex", message: "human answered your question already" });
    roomSend(db, { room, agent: "codex", message: "second" });

    const run = runHook(preToolUse(), env);
    expect(run.context).toMatch(new RegExp(`ai-room: 2 unread message\\(s\\) in room '${room}'`));
    expect(run.context).toMatch(new RegExp(`room_wait\\(room='${room}', agent='claude'\\)`));
    expect(run.context!.length).toBeLessThan(260);
  });

  it("never carries message content", () => {
    roomSend(db, { room, agent: "codex", message: "SEGREDO-NAO-PODE-VAZAR" });
    const run = runHook(preToolUse(), env);
    expect(run.stdout).not.toContain("SEGREDO");
    const log = fs.readFileSync(path.join(logDir, "unread-hook.jsonl"), "utf8");
    expect(log).not.toContain("SEGREDO");
    expect(JSON.parse(log.trim())).toMatchObject({
      room,
      agent: "claude",
      unread: 1,
      boundary: "PreToolUse",
    });
  });

  it("does not advance the cursor: the message stays unread until the agent reads it", () => {
    roomSend(db, { room, agent: "codex", message: "um" });
    const unread = () => roomWho(db, { room }).find((p) => p.agent === "claude")!.unread;

    expect(runHook(preToolUse(), env).context).toBeTruthy();
    expect(unread()).toBe(1);
    expect(runHook(preToolUse(), env).context).toBeTruthy();
    expect(unread()).toBe(1);

    // Only the agent's own room_listen/room_wait consumes.
    roomListen(db, { room, agent: "claude" });
    expect(unread()).toBe(0);
    expect(runHook(preToolUse(), env).stdout).toBe("");
  });

  it("stays quiet while the agent is calling ai-room itself", () => {
    roomSend(db, { room, agent: "codex", message: "um" });
    for (const tool of ["mcp__ai_room__room_wait", "mcp__ai-room__room_listen", "room_send"]) {
      expect(runHook(preToolUse(tool), env).stdout).toBe("");
    }
  });

  it("asks only about its own room and agent", () => {
    const other = `outra-${Math.random().toString(36).slice(2, 8)}`;
    roomJoin(db, { room: other, agent: "claude" });
    roomJoin(db, { room: other, agent: "codex" });
    roomSend(db, { room: other, agent: "codex", message: "assunto de outra sala" });

    // Unread exists, but in a room this agent's launcher did not name.
    expect(runHook(preToolUse(), env).stdout).toBe("");
    expect(runHook(preToolUse(), { ...env, AI_ROOM_ROOM: other }).context).toContain(`room '${other}'`);
  });

  it("takes identity from the launcher only, never from session text", () => {
    roomSend(db, { room, agent: "codex", message: "um" });
    // A transcript that mentions the room is not identity: an unrelated session
    // must never be told about a room it did not join.
    const transcript = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ room, agent: "claude" }) + "\n");
    const anonymous: Record<string, string> = { ...env };
    delete anonymous.AI_ROOM_ROOM;
    delete anonymous.AI_ROOM_AGENT;
    expect(runHook({ ...preToolUse(), transcript_path: transcript }, anonymous).stdout).toBe("");
  });

  it("stays quiet when it cannot tell who it is", () => {
    roomSend(db, { room, agent: "codex", message: "um" });
    const anonymous = { ...env };
    delete (anonymous as Record<string, string>).AI_ROOM_ROOM;
    delete (anonymous as Record<string, string>).AI_ROOM_AGENT;
    expect(runHook(preToolUse(), anonymous).stdout).toBe("");
  });

  it("fails open when ai-room is not running", () => {
    const run = runHook(preToolUse(), { ...env, AI_ROOM_PORT: "1" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("fails open on a slow endpoint instead of stalling the tool call", async () => {
    const slow = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(() => {
        /* never answers */
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = slow.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const startedAt = Date.now();
    const run = runHook(preToolUse(), {
      ...env,
      AI_ROOM_PORT: String(address.port),
      AI_ROOM_HOOK_TIMEOUT: "0.3",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    slow.closeAllConnections?.();
    await new Promise((resolve) => slow.close(resolve));
  });

  it("fails open on a response that is not the expected JSON", async () => {
    const garbage = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => res.end("<html>nope</html>"));
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = garbage.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const run = runHook(preToolUse(), { ...env, AI_ROOM_PORT: String(address.port) });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    await new Promise((resolve) => garbage.close(resolve));
  });

  it("fails open on junk input", () => {
    const result = spawnSync(HOOK, { input: "not json", encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status).toBe(0);
    expect(`${result.stdout}`.trim()).toBe("");
  });
});

describe("fast path before Python", () => {
  let dir: string;
  let marker: string;
  let fakePython: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-fast-"));
    marker = path.join(dir, "python-started");
    // Stands in for the interpreter: if the wrapper ever reaches Python, this
    // leaves proof behind. Absence of the file is the assertion.
    fakePython = path.join(dir, "fake-python");
    fs.writeFileSync(fakePython, `#!/bin/sh\necho started > ${JSON.stringify(marker)}\nexit 0\n`);
    fs.chmodSync(fakePython, 0o755);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string>) =>
    spawnSync(HOOK, {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
      encoding: "utf8",
      env: { ...process.env, AI_ROOM_PYTHON: fakePython, ...env },
    });

  it("never starts Python without a room", () => {
    const result = run({ AI_ROOM_ROOM: "", AI_ROOM_AGENT: "claude" });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("never starts Python without an agent", () => {
    const result = run({ AI_ROOM_ROOM: "r", AI_ROOM_AGENT: "" });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("stays completely silent on the fast path", () => {
    const result = run({ AI_ROOM_ROOM: "", AI_ROOM_AGENT: "" });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("hands over to Python once the session belongs to a room", () => {
    const result = run({ AI_ROOM_ROOM: "r", AI_ROOM_AGENT: "claude" });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("passes room names with spaces and punctuation through untouched", () => {
    // The wrapper must not re-quote or split what the launcher exported.
    const echo = path.join(dir, "echo-env");
    fs.writeFileSync(
      echo,
      `#!/bin/sh\nprintf '%s|%s|%s' "$AI_ROOM_ROOM" "$AI_ROOM_AGENT" "$2" > ${JSON.stringify(marker)}\n`
    );
    fs.chmodSync(echo, 0o755);
    spawnSync(HOOK, {
      input: "{}",
      encoding: "utf8",
      env: {
        ...process.env,
        AI_ROOM_PYTHON: echo,
        AI_ROOM_ROOM: "OP-3563/auth fix",
        AI_ROOM_AGENT: "claude",
      },
    });
    const [room, agent] = fs.readFileSync(marker, "utf8").split("|");
    expect(room).toBe("OP-3563/auth fix");
    expect(agent).toBe("claude");
  });

  it("resolves the Python hook next to itself, whatever the working directory", () => {
    const result = spawnSync(HOOK, {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
      encoding: "utf8",
      cwd: os.tmpdir(),
      env: { ...process.env, AI_ROOM_PYTHON: fakePython, AI_ROOM_ROOM: "r", AI_ROOM_AGENT: "claude" },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe("hook install surface", () => {
  it("points each harness at its own config and flags Codex's trust gate", () => {
    const status = hookStatus();
    expect(status.map((entry) => entry.harness)).toEqual(["claude", "codex"]);
    expect(status[0].configPath).toMatch(/\.claude\/settings\.json$/);
    expect(status[1].configPath).toMatch(/\.codex\/hooks\.json$/);
    expect(status[1].note).toMatch(/trust/i);
    for (const entry of status) {
      expect(entry.event).toBe("PreToolUse");
      expect(entry.command).toContain(UNREAD_HOOK);
    }
  });

  it("emits a snippet each harness can read", () => {
    for (const harness of ["claude", "codex"] as const) {
      const parsed = JSON.parse(hookSnippet(harness)) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ type: string; command: string }> }> };
      };
      expect(parsed.hooks.PreToolUse[0].hooks[0].type).toBe("command");
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain(UNREAD_HOOK);
    }
  });

  it("ships both halves executable: the wrapper and the hook it defers to", () => {
    for (const script of [UNREAD_HOOK, UNREAD_HOOK_PY]) {
      const file = hookPath(script);
      expect(fs.existsSync(file)).toBe(true);
      fs.accessSync(file, fs.constants.X_OK);
    }
  });

  it("installs the wrapper, not the interpreter call", () => {
    expect(hookCommand(UNREAD_HOOK)).toContain(UNREAD_HOOK);
    expect(hookCommand(UNREAD_HOOK)).not.toContain("python");
  });

  it("says plainly that Codex needs a human to trust the hook once", () => {
    expect(CODEX_TRUST_NOTE).toMatch(/trust/i);
    expect(CODEX_TRUST_NOTE).toMatch(/human/i);
    expect(CODEX_TRUST_NOTE).toMatch(/skips it until then/i);
    // No invented trust detection: Codex exposes no way to read that state.
    expect(CODEX_TRUST_NOTE).toMatch(/cannot tell whether you already did/i);
  });
});
