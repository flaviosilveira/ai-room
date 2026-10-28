import fs from "node:fs";
import path from "node:path";
import { claudeDir as claudeHome, codexDir as codexHome } from "./platform.js";

/**
 * Tokens each room's agents spent, read from the harnesses' own session logs:
 * Claude Code's transcripts and Codex's rollouts. A session belongs to a room
 * when its first prompt is the one ai-room launches it with. agy keeps no
 * usage on disk, so it is reported without numbers.
 */
export interface AgentUsage {
  room: string;
  agent: string;
  harness: "claude" | "codex";
  sessions: number;
  input: number;
  cached: number;
  output: number;
  /** Codex only: how much of the plan's rate-limit window the latest session had used. */
  planUsedPercent?: number;
  planWindowMinutes?: number;
  lastAt: number;
}

const JOIN = /Join the ai-room \\?"([^"\\]+)\\?" as agent \\?"([^"\\]+)\\?"/;

function recentFiles(dir: string, since: number, depth: number): string[] {
  const found: string[] = [];
  const walk = (current: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && level < depth) walk(full, level + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(full).mtimeMs >= since) found.push(full);
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  walk(dir, 0);
  return found;
}

/** The room and agent a session was launched for, from its first lines only. */
function roomOf(lines: string[]): { room: string; agent: string } | null {
  for (const line of lines.slice(0, 60)) {
    const match = JOIN.exec(line);
    if (match) return { room: match[1], agent: match[2] };
  }
  return null;
}

function add(totals: Map<string, AgentUsage>, entry: AgentUsage): void {
  const key = JSON.stringify([entry.room, entry.agent, entry.harness]);
  const current = totals.get(key);
  if (!current) {
    totals.set(key, entry);
    return;
  }
  current.sessions += entry.sessions;
  current.input += entry.input;
  current.cached += entry.cached;
  current.output += entry.output;
  if (entry.lastAt >= current.lastAt) {
    current.lastAt = entry.lastAt;
    current.planUsedPercent = entry.planUsedPercent ?? current.planUsedPercent;
    current.planWindowMinutes = entry.planWindowMinutes ?? current.planWindowMinutes;
  }
}

function claudeSession(file: string): AgentUsage | null {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const owner = roomOf(lines);
  if (!owner) return null;
  // A streamed reply is logged once per chunk with the same usage; count each message once.
  const seen = new Set<string>();
  const usage = { input: 0, cached: 0, output: 0, lastAt: 0 };
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line) as { timestamp?: string; message?: { id?: string; usage?: Record<string, number> } };
      const u = entry.message?.usage;
      const id = entry.message?.id;
      if (!u || (id && seen.has(id))) continue;
      if (id) seen.add(id);
      usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.cached += u.cache_read_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.lastAt = Math.max(usage.lastAt, Date.parse(entry.timestamp ?? "") || 0);
    } catch {
      /* a partial line */
    }
  }
  return { ...owner, harness: "claude", sessions: 1, ...usage };
}

type CodexEvent = {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: { total_token_usage?: Record<string, number> } | null;
    rate_limits?: { primary?: { used_percent?: number; window_minutes?: number } | null } | null;
  };
};

function codexSession(file: string): AgentUsage | null {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const owner = roomOf(lines);
  if (!owner) return null;
  const usage: AgentUsage = { ...owner, harness: "codex", sessions: 1, input: 0, cached: 0, output: 0, lastAt: 0 };
  let counted = false;
  // The totals and the plan window do not always come in the same event; take the latest of each.
  for (let i = lines.length - 1; i >= 0 && (!counted || usage.planUsedPercent === undefined); i -= 1) {
    if (!lines[i].includes('"token_count"')) continue;
    let entry: CodexEvent;
    try {
      entry = JSON.parse(lines[i]) as CodexEvent;
    } catch {
      continue;
    }
    const total = entry.payload?.info?.total_token_usage;
    if (total && !counted) {
      counted = true;
      usage.cached = total.cached_input_tokens ?? 0;
      usage.input = (total.input_tokens ?? 0) - usage.cached;
      usage.output = total.output_tokens ?? 0;
      usage.lastAt = Date.parse(entry.timestamp ?? "") || 0;
    }
    const plan = entry.payload?.rate_limits?.primary;
    if (plan?.used_percent !== undefined && usage.planUsedPercent === undefined) {
      usage.planUsedPercent = plan.used_percent;
      usage.planWindowMinutes = plan.window_minutes;
    }
  }
  return usage;
}

export function roomUsage(options: { room?: string; days?: number; claudeDir?: string; codexDir?: string } = {}): AgentUsage[] {
  const since = Date.now() - (options.days ?? 7) * 86_400_000;
  const claudeDir = options.claudeDir ?? process.env.AI_ROOM_CLAUDE_PROJECTS ?? path.join(claudeHome(), "projects");
  const codexDir = options.codexDir ?? process.env.AI_ROOM_CODEX_SESSIONS ?? path.join(codexHome(), "sessions");
  const totals = new Map<string, AgentUsage>();
  for (const file of recentFiles(claudeDir, since, 2)) {
    const usage = claudeSession(file);
    if (usage && (!options.room || usage.room === options.room)) add(totals, usage);
  }
  for (const file of recentFiles(codexDir, since, 4)) {
    const usage = codexSession(file);
    if (usage && (!options.room || usage.room === options.room)) add(totals, usage);
  }
  return [...totals.values()].sort((a, b) => a.room.localeCompare(b.room) || b.input + b.output - (a.input + a.output));
}

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

/** One line per agent: fresh input, cache reads (cheap), output, and Codex's plan window. */
export function renderUsage(rows: AgentUsage[]): string {
  if (!rows.length) return "no Claude or Codex sessions launched by ai-room in that period (agy keeps no usage on disk).";
  const lines: string[] = [];
  let room = "";
  for (const row of rows) {
    if (row.room !== room) {
      room = row.room;
      lines.push(`${lines.length ? "\n" : ""}${room}`);
    }
    const plan = row.planUsedPercent === undefined ? "" : `  plan ${row.planUsedPercent}% of ${Math.round((row.planWindowMinutes ?? 0) / 60)}h`;
    lines.push(
      `  ${row.agent.padEnd(10)} input ${compact(row.input).padStart(6)}  cache ${compact(row.cached).padStart(6)}  output ${compact(row.output).padStart(6)}  ${row.sessions} session(s)${plan}`
    );
  }
  return lines.join("\n");
}
