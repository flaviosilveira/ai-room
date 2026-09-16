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
};

export function resolveConvention(preset: string | null | undefined): string | null {
  if (!preset) return null;
  const text = CONVENTION_PRESETS[preset];
  if (!text) {
    throw new Error(
      `Unknown convention preset "${preset}". Available: ${Object.keys(CONVENTION_PRESETS).join(", ")}.`
    );
  }
  return text;
}

export function resolveTool(name: string): ToolDeclaration {
  return TOOL_PRESETS[name] ?? { name };
}
