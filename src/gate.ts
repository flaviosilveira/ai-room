import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookCommand, hookPath } from "./hooks.js";

/**
 * Installs ai-room's gate as a PreToolUse hook in Claude Code, Codex and agy,
 * and gives the human a policy to edit. With it in a harness's hooks, ai-room
 * launches that harness in rooms with its own prompts skipped (Claude, agy):
 * the gate lets work through and files what cannot be undone for /allow.
 * Codex keeps its own reviewer and gets the ask and deny lists on top.
 */
export type GateHarness = "claude" | "codex" | "agy";

interface Target {
  harness: GateHarness;
  file: string;
  command: string;
  read: (config: Record<string, unknown>) => HookGroup[];
  write: (config: Record<string, unknown>, groups: HookGroup[]) => void;
  matcher: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

const MARK = "ai-room-gate";

export function policyPath(home = os.homedir()): string {
  return path.join(home, ".ai-room", "policy.json");
}

function targets(home: string): Target[] {
  const wrapper = hookCommand("ai-room-gate.sh");
  const nested = (config: Record<string, unknown>) => ((config.hooks ??= {}) as Record<string, HookGroup[]>);
  return [
    {
      harness: "claude",
      file: path.join(home, ".claude", "settings.json"),
      command: `${wrapper} --harness claude`,
      matcher: "*",
      read: (config) => nested(config).PreToolUse ?? [],
      write: (config, groups) => void (nested(config).PreToolUse = groups),
    },
    {
      harness: "codex",
      file: path.join(home, ".codex", "hooks.json"),
      command: `${wrapper} --harness codex`,
      matcher: "",
      read: (config) => nested(config).PreToolUse ?? [],
      write: (config, groups) => void (nested(config).PreToolUse = groups),
    },
    {
      // agy names each hook and runs it without the wrapper: it needs an answer
      // even outside a room, where the wrapper would say nothing.
      harness: "agy",
      file: path.join(home, ".gemini", "config", "hooks.json"),
      command: `python3 ${hookCommand("ai-room-gate.py")} --harness agy`,
      matcher: "*",
      read: (config) => ((config[MARK] as { PreToolUse?: HookGroup[] } | undefined)?.PreToolUse ?? []),
      write: (config, groups) => {
        if (groups.length) config[MARK] = { PreToolUse: groups };
        else delete config[MARK];
      },
    },
  ];
}

function load(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function save(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-ai-room-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

const hasGate = (groups: HookGroup[]) => groups.some((group) => group.hooks?.some((hook) => hook.command?.includes(MARK)));

export function gateStatus(home = os.homedir()): { harness: GateHarness; file: string; installed: boolean }[] {
  return targets(home).map((target) => ({ harness: target.harness, file: target.file, installed: hasGate(target.read(load(target.file))) }));
}

/** Codex runs hooks only with its hooks feature on. */
function enableCodexHooks(home: string): boolean {
  const file = path.join(home, ".codex", "config.toml");
  let toml = "";
  try {
    toml = fs.readFileSync(file, "utf8");
  } catch {
    /* no config yet */
  }
  if (/^\s*hooks\s*=\s*true\s*$/m.test(toml)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (toml) fs.copyFileSync(file, `${file}.bak-ai-room-${Date.now()}`);
  const next = /^\[features\]\s*$/m.test(toml)
    ? toml.replace(/^\[features\]\s*$/m, "[features]\nhooks = true")
    : `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}\n[features]\nhooks = true\n`;
  fs.writeFileSync(file, next);
  return true;
}

export function installGate(home = os.homedir(), only?: GateHarness[]): string[] {
  const done: string[] = [];
  const policy = policyPath(home);
  if (!fs.existsSync(policy)) {
    fs.mkdirSync(path.dirname(policy), { recursive: true });
    fs.copyFileSync(hookPath("default-policy.json"), policy);
    done.push(`policy: wrote ${policy} (edit it to change what waits for you)`);
  } else done.push(`policy: kept your ${policy}`);

  for (const target of targets(home)) {
    if (only && !only.includes(target.harness)) continue;
    const config = load(target.file);
    const groups = target.read(config);
    if (hasGate(groups)) {
      done.push(`${target.harness}: already installed`);
      continue;
    }
    target.write(config, [...groups, { matcher: target.matcher, hooks: [{ type: "command", command: target.command, ...(target.harness === "agy" ? { timeout: 60 } : {}) }] }]);
    save(target.file, config);
    done.push(`${target.harness}: installed in ${target.file}`);
    if (target.harness === "codex" && enableCodexHooks(home)) done.push("codex: turned on hooks in ~/.codex/config.toml");
  }
  return done;
}

export function uninstallGate(home = os.homedir()): string[] {
  const done: string[] = [];
  for (const target of targets(home)) {
    const config = load(target.file);
    const groups = target.read(config);
    if (!hasGate(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks?.filter((hook) => !hook.command?.includes(MARK)) }))
      .filter((group) => group.hooks?.length);
    target.write(config, kept);
    save(target.file, config);
    done.push(`${target.harness}: removed from ${target.file}`);
  }
  return done.length ? done : ["the gate was not installed"];
}
