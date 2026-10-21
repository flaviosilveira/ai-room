import crypto from "node:crypto";

/**
 * What each agent is doing right now, read from its own pane rather than from
 * what it last declared. The harness's own indicator is the ground truth: Claude
 * Code prints "Flambéing… (2m · esc to interrupt)" while the model runs, Codex
 * "Working (12s • esc to interrupt)", and a permission prompt is on screen when
 * it waits for the human. When nothing matches, how long the pane has been
 * still says enough.
 */
export type LiveState = "working" | "asking" | "quiet";

export interface LiveReading {
  state: LiveState;
  /** The harness's own word for what it is doing ("Flambéing", "Working"). */
  label?: string;
  /** The harness's own elapsed time, when it shows one. */
  elapsed?: string;
}

const ASKING = [
  /Do you want to (proceed|make this edit|create|run|allow|overwrite)/i,
  /Run this command\?/i,
  /Allow access to this file\?/i,
  /Would you like to (run|make|allow)/i,
  /Requesting permission for/i,
  /needs your approval/i,
  /❯\s*1\.\s*Yes/,
];
// Claude Code: a spinner glyph, a verb ending in "…", then the time so far:
// "✻ Perambulating… (11m 14s · ↓ 12.4k tokens)". Once done it reads "Cooked for 11m".
const CLAUDE_BUSY = /^\s*[✻✶✳✢✽·*●]\s+([A-ZÀ-Ý][\p{L}]+)…\s*\(((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)/u;
// Codex and agy: "Working (12s • esc to interrupt)".
const OTHER_BUSY = /esc to (interrupt|cancel)/i;
const OTHER_ELAPSED = /\((\d+[hms](?:\s*\d+[ms])*)\s*[·•]/;

/** Reads the last lines of a pane, newest last. */
export function readPane(text: string): LiveReading {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-25);
  const tail = lines.slice(-12).join("\n");
  if (ASKING.some((pattern) => pattern.test(tail))) return { state: "asking" };
  for (const line of [...lines].reverse()) {
    const claude = CLAUDE_BUSY.exec(line);
    if (claude) return { state: "working", label: claude[1], ...(claude[2].trim() ? { elapsed: claude[2].trim() } : {}) };
    if (OTHER_BUSY.test(line)) {
      const elapsed = OTHER_ELAPSED.exec(line)?.[1];
      return { state: "working", label: /\b(Working|Thinking)\b/.exec(line)?.[1] ?? "Working", ...(elapsed ? { elapsed } : {}) };
    }
  }
  return { state: "quiet" };
}

/** Remembers when each pane last changed, so a still pane can say for how long. */
export class LiveTracker {
  private readonly seen = new Map<string, { hash: string; changedAt: number }>();

  observe(paneId: string, text: string, now = Date.now()): LiveReading & { stillForMs: number } {
    const hash = crypto.createHash("sha1").update(text).digest("hex");
    const previous = this.seen.get(paneId);
    const changedAt = previous && previous.hash === hash ? previous.changedAt : now;
    this.seen.set(paneId, { hash, changedAt });
    return { ...readPane(text), stillForMs: now - changedAt };
  }
}

const span = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

/**
 * One tmux-styled line for the status bar. An agent that declared itself
 * working while its pane has not moved for a while is flagged: that is the
 * stuck case the declared status alone never shows.
 */
export function renderLive(
  agents: { agent: string; reading: LiveReading & { stillForMs: number }; declared?: string }[],
  stuckAfterMs = 5 * 60_000
): string {
  if (!agents.length) return "#[fg=colour245]no agents in this room";
  return agents
    .map(({ agent, reading, declared }) => {
      if (reading.state === "working") {
        const what = [reading.label, reading.elapsed].filter(Boolean).join(" ");
        return `#[fg=colour114]✻ ${agent}#[fg=colour250]${what ? ` ${what}` : ""}`;
      }
      if (reading.state === "asking") return `#[fg=colour215,bold]⏸ ${agent} asking#[nobold]`;
      if (declared === "working" && reading.stillForMs > stuckAfterMs) return `#[fg=colour203]⚠ ${agent} still ${span(reading.stillForMs)}`;
      return `#[fg=colour245]· ${agent} ${declared === "idle" ? "idle" : `quiet ${span(reading.stillForMs)}`}`;
    })
    .join("#[fg=colour240]  │  ");
}
