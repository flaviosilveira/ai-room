import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDeclaration } from "./types.js";

/**
 * Convention presets are style contracts delivered in the join briefing, so the
 * same rules reach Claude Code, Codex and AGY without installing a plugin in
 * each harness.
 */
export const CONVENTION_PRESETS: Record<string, string> = {
  // Derived from the caveman plugin by Julius Brussee (MIT).
  // https://github.com/JuliusBrussee/caveman
  caveman: [
    "Respond terse like smart caveman. All technical substance stay. Only fluff die.",
    "Drop: articles (a/an/the), filler (just/really/basically/actually/simply),",
    "pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK.",
    "Short synonyms (big not extensive, fix not \"implement a solution for\").",
    "Technical terms exact. Code blocks unchanged. Errors quoted exact.",
    "Pattern: [thing] [action] [reason]. [next step].",
    "Write commits, PRs and code comments in normal prose, never compressed.",
    "Drop the compression for security warnings, irreversible-action confirmations,",
    "and any multi-step sequence where dropped articles make the order ambiguous.",
  ].join(" "),

  concise: [
    "Answer in at most five sentences unless asked for more.",
    "Lead with the conclusion, then the reason. No preamble, no recap of the question.",
  ].join(" "),

  // Derived from ponytail by Dietrich Gebert (MIT).
  // https://github.com/DietrichGebert/ponytail
  ponytail: [
    "Write the least code that solves the task, like the laziest senior developer in the room.",
    "Before writing anything, stop at the first of these that works: the change is not needed;",
    "the codebase already has it; the standard library has it; the platform does it natively;",
    "an installed dependency covers it; it fits in one line. Only then write the minimum that works.",
    "Never cut input validation, error handling that prevents data loss, security measures or",
    "basic accessibility to get there. Say which rung you stopped at when it is not obvious.",
  ].join(" "),

  // Added on its own when a room gets a lead: one voice toward the human.
  lead: [
    "One agent is the room's lead: its role in the roster includes \"lead\". Only the lead",
    "addresses the human; everyone else sends what they need from the human to the lead",
    "through room_send and keeps working. The lead asks the human one thing per message,",
    "starting it with [PARA VOCÊ #n] (n counting up in this room), with the options spelled",
    "out when there are any, and never inside a longer update. Anything for the human to",
    "read or forward — a draft, a summary, a plan — goes in a file under .ai-room/para-voce/",
    "and the message only says [PARA VOCÊ] entrega: <path>. When the human answers #n, the",
    "lead tells the room. If the lead leaves, the room says who takes over.",
  ].join(" "),

  rigorous: [
    "State what you verified and how, and separate it from what you inferred.",
    "Never report work as done without running it. Quote real output, including failures.",
  ].join(" "),
};

/**
 * Tool presets are declarations, not integrations: ai-room names the tool and
 * how the room uses it, and each agent invokes it through its own skills. That
 * keeps ai-room a message bus rather than a distribution channel.
 */
export const TOOL_PRESETS: Record<string, ToolDeclaration> = {
  graphify: {
    name: "graphify",
    purpose:
      "Build and query a knowledge graph of this codebase (AST-based, via tree-sitter) before making claims about how the code fits together.",
    howToUse:
      "Run `/graphify .` or `graphify extract` in the workspace, then `graphify query <question>`, `graphify path <a> <b>` to trace connections, and `graphify explain <node>`. Outputs graph.json, graph.html and GRAPH_REPORT.md. Install with `uv tool install graphifyy`.",
  },
  "grill-me": {
    name: "grill-me",
    purpose:
      "Interrogate a plan until it can be committed to: one round of questions at a time, each asked only once what it depends on is settled. Writes no files.",
    howToUse:
      "Only when a human asks for it: run `/grill-me` in a fresh conversation with plan mode off, answer round by round, and post the settled plan to the room. Skill from mattpocock/skills.",
  },
  "grill-with-docs": {
    name: "grill-with-docs",
    purpose:
      "The grill-me interview aimed at this codebase: settled terms go to a CONTEXT.md glossary and each decision that holds up becomes an ADR in docs/adr/.",
    howToUse:
      "Only when a human asks for it: run `/grill-with-docs` in the workspace. It writes files, so announce in the room which CONTEXT.md and ADRs it produced. Skill from mattpocock/skills.",
  },
  rtk: {
    name: "rtk",
    purpose:
      "Compresses the output of common shell commands (git, test runners, ls) before you read it, saving tokens on every tool call.",
    howToUse:
      "Nothing to invoke when its hook is installed (`rtk init -g`, `--codex`, `--gemini`): commands are rewritten to `rtk <cmd>` automatically. Run `rtk <cmd>` by hand where there is no hook, and `rtk gain` to see the savings. When compressed output hides a detail you need, rerun the plain command.",
  },
  ponytail: {
    name: "ponytail",
    purpose:
      "Keeps changes minimal: before writing code, check whether it needs to exist, already exists, or comes from the standard library, the platform or an installed dependency.",
    howToUse:
      "Where the plugin is installed use `/ponytail`, `/ponytail-review` on a diff and `/ponytail-audit` on the repo. Elsewhere follow the same ladder by hand; `--convention ponytail` puts it in every briefing.",
  },
};

/**
 * How `ai-room open` tells whether a declared tool is present on this machine.
 * Advisory only and never run by the server: a missing tool is reported to the
 * human, and the room opens anyway.
 */
interface ToolCheck {
  bins?: string[];
  /** Paths under the home directory; any one existing counts. */
  paths?: string[];
  /** Substrings looked for in Claude Code's installed plugin list. */
  plugins?: string[];
  install: string;
}

const skillPaths = (skill: string) => [
  `.claude/skills/${skill}`,
  `.agents/skills/${skill}`,
  `.codex/skills/${skill}`,
];

export const TOOL_CHECKS: Record<string, ToolCheck> = {
  graphify: { bins: ["graphify"], install: "uv tool install graphifyy" },
  "grill-me": {
    paths: skillPaths("grill-me"),
    plugins: ["mattpocock"],
    install: "npx skills@latest add mattpocock/skills (or the mattpocock Claude Code plugin)",
  },
  "grill-with-docs": {
    paths: skillPaths("grill-with-docs"),
    plugins: ["mattpocock"],
    install: "npx skills@latest add mattpocock/skills (or the mattpocock Claude Code plugin)",
  },
  rtk: { bins: ["rtk"], install: "brew install rtk && rtk init -g" },
  ponytail: {
    paths: [...skillPaths("ponytail"), ".gemini/extensions/ponytail"],
    plugins: ["ponytail"],
    install: "/plugin marketplace add DietrichGebert/ponytail, then /plugin install ponytail@ponytail",
  },
};

function binOnPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function toolInstalled(
  name: string,
  env: { home?: string; has?: (bin: string) => boolean } = {}
): boolean | null {
  const check = TOOL_CHECKS[name];
  if (!check) return null;
  const home = env.home ?? os.homedir();
  const has = env.has ?? binOnPath;
  if (check.bins?.some(has)) return true;
  if (check.paths?.some((rel) => fs.existsSync(path.join(home, rel)))) return true;
  if (check.plugins?.length) {
    try {
      const installed = fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8");
      if (check.plugins.some((plugin) => installed.includes(plugin))) return true;
    } catch {
      /* no plugin list */
    }
  }
  return false;
}

/** Declared tools with a known check that this machine does not have. */
export function missingTools(
  names: string[],
  env?: { home?: string; has?: (bin: string) => boolean }
): { name: string; install: string }[] {
  return names
    .filter((name) => toolInstalled(name, env) === false)
    .map((name) => ({ name, install: TOOL_CHECKS[name].install }));
}

/** Presets combine: "caveman,ponytail" delivers both, in that order. */
export function resolveConvention(preset: string | null | undefined): string | null {
  if (!preset) return null;
  const names = preset.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !CONVENTION_PRESETS[name]);
  if (unknown.length) {
    throw new Error(
      `Unknown convention preset "${unknown.join(", ")}". Available: ${Object.keys(CONVENTION_PRESETS).join(", ")}.`
    );
  }
  return names.map((name) => CONVENTION_PRESETS[name]).join("\n\n") || null;
}

export function resolveTool(name: string): ToolDeclaration {
  return TOOL_PRESETS[name] ?? { name };
}
