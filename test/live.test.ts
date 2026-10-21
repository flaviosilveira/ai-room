import { describe, expect, it } from "vitest";
import { LiveTracker, readPane, renderLive } from "../src/live.js";

const pane = (...lines: string[]) => ["", "⏺ Reading the bill service", ...lines, "", "  [CAVEMAN] · fix/x↑14↓10 · Opus 5.5 · 5…"].join("\n");

describe("reading what an agent's pane shows", () => {
  it("knows Claude Code is working from its spinner line, and when it is done", () => {
    expect(readPane(pane("✻ Perambulating… (11m 14s · ↓ 12.4k tokens)"))).toEqual({ state: "working", label: "Perambulating", elapsed: "11m 14s" });
    expect(readPane(pane("· Burrowing… (1m 20s · ↓ 1.7k tokens · thought for 2s)"))).toMatchObject({ label: "Burrowing", elapsed: "1m 20s" });
    expect(readPane(pane("✻ Cooked for 11m 14s"))).toEqual({ state: "quiet" });
    expect(readPane(pane())).toEqual({ state: "quiet" });
  });

  it("knows Codex is working, and any harness waiting for permission", () => {
    expect(readPane("• Working (12s • esc to interrupt)")).toMatchObject({ state: "working", label: "Working", elapsed: "12s" });
    expect(readPane("Requesting permission for:\n   git push origin main\nRun this command?\n> 1. Yes, run command")).toEqual({ state: "asking" });
    expect(readPane("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toEqual({ state: "asking" });
  });

  it("counts how long a pane has been still, and flags a 'working' agent that stopped moving", () => {
    const tracker = new LiveTracker();
    tracker.observe("%1", "same", 0);
    const still = tracker.observe("%1", "same", 6 * 60_000);
    expect(still.stillForMs).toBe(6 * 60_000);
    expect(tracker.observe("%1", "changed", 6 * 60_000 + 1).stillForMs).toBe(0);
    const line = renderLive([
      { agent: "claude", reading: { state: "working", label: "Flambéing", elapsed: "2m", stillForMs: 0 } },
      { agent: "codex", reading: { ...still }, declared: "working" },
      { agent: "agy", reading: { state: "quiet", stillForMs: 30_000 }, declared: "idle" },
    ]);
    expect(line).toContain("✻ claude#[fg=colour250] Flambéing 2m");
    expect(line).toContain("⚠ codex still 6m");
    expect(line).toContain("· agy idle");
  });
});
