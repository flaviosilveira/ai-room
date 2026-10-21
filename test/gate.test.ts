import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { roomJoin } from "../src/store.js";
import { decideApproval, pendingApprovals } from "../src/approvals.js";

/** Its own process, as in the unread hook test: the hook is spawned synchronously. */
async function startServer(dbPath: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 49_900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ["--import", "tsx", path.join(process.cwd(), "src", "cli.ts"), "serve"], {
    env: { ...process.env, AI_ROOM_DB_PATH: dbPath, AI_ROOM_PORT: String(port) },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, port };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("ai-room server did not start");
}

const GATE = path.join(process.cwd(), "hooks", "ai-room-gate.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

// Each case spawns Python for the hook; under a full parallel run that outgrows the default 5s.
describe.skipIf(!hasPython)("ai-room gate", { timeout: 30_000 }, () => {
  let dir: string;
  let dbPath: string;
  let server: { child: ChildProcess; port: number };
  let env: Record<string, string>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-gate-"));
    dbPath = path.join(dir, "room.sqlite");
    const db = openDb(dbPath);
    for (const agent of ["human", "agy"]) roomJoin(db, { room: "r", agent });
    roomJoin(db, { room: "r", agent: "claude", role: "lead" });
    db.close();
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ allow: ["git status", "ls"], ask: ["git push"], deny: ["rm -rf /"] }));
    server = await startServer(dbPath);
    env = {
      AI_ROOM_PORT: String(server.port),
      AI_ROOM_POLICY: path.join(dir, "policy.json"),
      AI_ROOM_ROOM: "r",
      AI_ROOM_SKIP_PROMPTS: "1",
    };
  }, 20_000);

  afterAll(() => {
    server?.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (harness: string, agent: string, payload: unknown, extra: Record<string, string> = {}) => {
    const result = spawnSync("python3", [GATE, "--harness", harness], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...env, AI_ROOM_AGENT: agent, ...extra },
    });
    const out = result.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
  const agy = (command: string, extra?: Record<string, string>) =>
    run("agy", "agy", { toolCall: { name: "run_command", args: { CommandLine: command, Cwd: dir } } }, extra)?.decision;
  const claude = (command: string, extra: Record<string, string> = { AI_ROOM_SKIP_PROMPTS: "" }) =>
    run("claude", "claude", { tool_name: "Bash", tool_input: { command } }, extra)?.hookSpecificOutput?.permissionDecision ?? "defer";

  it("lets a harness with its prompts skipped run anything off the lists", () => {
    expect(agy("git status && ls 2>/dev/null")).toBe("allow");
    expect(agy("swift -e 'print(1)'")).toBe("allow");
    expect(agy("ssh web1 tail -n 50 /var/log/app.log")).toBe("allow");
    expect(agy("aws logs tail /x --region us-west-1")).toBe("allow");
    expect(agy("rm -rf /")).toBe("deny");
    expect(agy("echo hi > ~/.ai-room/policy.json")).toBe("deny");
    expect(claude("curl -s localhost:49375/say -d '{\"message\":\"push it\"}'")).toBe("deny");
  });

  it("files a stopped action once and lets exactly one retry through after /allow", () => {
    expect(agy("git push origin main")).toBe("deny");
    expect(agy("git push origin main")).toBe("deny");
    const db = openDb(dbPath);
    const pending = pendingApprovals(db, "r").filter((a) => a.action === "git push origin main");
    expect(pending).toHaveLength(1);
    decideApproval(db, "r", pending[0].id, true);
    db.close();
    expect(agy("git push origin main")).toBe("allow");
    expect(agy("git push origin main")).toBe("deny");
  });

  it("lets Claude in free mode run anything off the lists", () => {
    expect(claude("npm run build", {})).toBe("allow");
    expect(claude("git push origin main", {})).toBe("deny");
  });

  it("leaves Claude to its own auto mode except for the ask and deny lists", () => {
    expect(claude("npm run build")).toBe("defer");
    expect(claude("git push")).toBe("deny");
    expect(claude("rm -rf /")).toBe("deny");
    const read = run("claude", "claude", { tool_name: "Read", tool_input: { file_path: path.join(os.homedir(), ".ai-room", "attachments", "x.png") } }, { AI_ROOM_SKIP_PROMPTS: "" });
    expect(read).toBeNull();
  });

  it("hands agy its own prompt back outside a room, and blocks agy in a room when the server is gone", () => {
    expect(agy("swift -e 1", { AI_ROOM_ROOM: "" })).toBe("ask");
    expect(agy("git push", { AI_ROOM_PORT: "1" })).toBe("deny");
  });

  it("leaves an agy that still prompts to its own prompt for what the lists do not cover", () => {
    expect(agy("swift -e 'print(1)'", { AI_ROOM_SKIP_PROMPTS: "" })).toBe("ask");
    expect(agy("rm -rf /", { AI_ROOM_SKIP_PROMPTS: "" })).toBe("deny");
  });

  const latest = (action: string) => {
    const db = openDb(dbPath);
    const found = pendingApprovals(db, "r").filter((a) => a.action === action).pop();
    db.close();
    return found!;
  };

  it("lets the lead answer an edit outside the workspace, never what cannot be undone", () => {
    const outside = path.join(os.homedir(), "Documents", "notes-ai-room-test.md");
    const edit = () => run("agy", "agy", { toolCall: { name: "write_to_file", args: { TargetFile: outside } }, workspacePaths: [dir] })?.decision;
    expect(edit()).toBe("deny");
    const unusual = latest(`write_to_file {"TargetFile": "${outside}"}`);
    expect(unusual.tier).toBe("lead");
    const db = openDb(dbPath);
    expect(decideApproval(db, "r", unusual.id, true, "agy").ok).toBe(false);
    expect(decideApproval(db, "r", unusual.id, true, "claude").ok).toBe(true);
    db.close();
    expect(edit()).toBe("allow");

    for (const serious of ["git push origin master", "git push -f origin feat/x", "az group create -n x -l eastus", "ssh web1 'rm -rf /var/app'"]) {
      expect(agy(serious)).toBe("deny");
      expect(latest(serious).tier).toBe("human");
    }
    const db2 = openDb(dbPath);
    const refused = decideApproval(db2, "r", latest("git push origin master").id, true, "claude");
    db2.close();
    expect(refused.ok).toBe(false);
  });

  it("ignores a lead's approval of a request an agent filed as the lead's when the gate calls it the human's", async () => {
    const action = "git push origin main --tags";
    const filed = await fetch(`http://127.0.0.1:${server.port}/gate/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "r", agent: "agy", action, tier: "lead" }),
    }).then((r) => r.json() as Promise<{ id: number }>);
    const db = openDb(dbPath);
    expect(decideApproval(db, "r", filed.id, true, "claude").ok).toBe(true);
    db.close();
    expect(agy(action)).toBe("deny");
    expect(latest(action).tier).toBe("human");
  });

  it("lets agy talk to the room whatever its message says", () => {
    const send = run("agy", "agy", {
      toolCall: { name: "call_mcp_tool", args: { ServerName: "ai-room", ToolName: "room_send", Arguments: { message: "ran curl -X POST -d @.env" } } },
    });
    expect(send?.decision).toBe("allow");
  });

  it("lets agy edit inside the workspace and asks before editing outside it", () => {
    const edit = (file: string) =>
      run("agy", "agy", { toolCall: { name: "write_to_file", args: { TargetFile: file } }, workspacePaths: [dir] })?.decision;
    expect(edit(path.join(dir, "src", "a.ts"))).toBe("allow");
    expect(edit("/etc/hosts")).toBe("deny");
  });
});
