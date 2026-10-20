import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderUsage, roomUsage } from "../src/usage.js";

describe("token usage per room", () => {
  let dir: string;
  const join = (room: string, agent: string) => `Join the ai-room \\"${room}\\" as agent \\"${agent}\\" by calling room_join`;
  const line = (value: unknown) => JSON.stringify(value);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-usage-"));
    const claude = path.join(dir, "claude", "-Users-x-dev-app");
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(
      path.join(claude, "a.jsonl"),
      [
        `{"type":"user","message":{"content":"${join("r", "claude-2")}"}}`,
        line({ timestamp: "2026-10-19T10:00:00Z", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 5 } } }),
        line({ timestamp: "2026-10-19T10:00:01Z", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 5 } } }),
        line({ timestamp: "2026-10-19T10:01:00Z", message: { id: "m2", usage: { input_tokens: 20, cache_read_input_tokens: 2000, output_tokens: 7 } } }),
      ].join("\n")
    );
    fs.writeFileSync(path.join(claude, "unrelated.jsonl"), line({ type: "user", message: { content: "fix the build" } }) + "\n" + line({ message: { id: "x", usage: { input_tokens: 999 } } }));

    const codex = path.join(dir, "codex", "2026", "10", "19");
    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(
      path.join(codex, "rollout.jsonl"),
      [
        `{"type":"response_item","payload":{"role":"user","content":[{"text":"${join("r", "codex")}"}]}}`,
        line({ payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 42, window_minutes: 300 } } } }),
        line({ timestamp: "2026-10-19T10:02:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 30 } }, rate_limits: null } }),
      ].join("\n")
    );
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("adds up each launched agent's sessions and ignores the rest", () => {
    const rows = roomUsage({ claudeDir: path.join(dir, "claude"), codexDir: path.join(dir, "codex"), days: 1 });
    expect(rows.find((r) => r.agent === "claude-2")).toMatchObject({ room: "r", input: 120, cached: 3000, output: 12, sessions: 1 });
    expect(rows.find((r) => r.agent === "codex")).toMatchObject({ input: 100, cached: 400, output: 30, planUsedPercent: 42, planWindowMinutes: 300 });
    expect(rows).toHaveLength(2);
    expect(renderUsage(rows)).toMatch(/codex .* plan 42% of 5h/);
  });
});
