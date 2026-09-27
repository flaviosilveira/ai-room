import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { LAUNCHERS, harnessFor, onPath } from "./invite.js";
import { LEAD_PREFERENCE, defaultsPath, expandInvite, loadOpenDefaults } from "./open.js";
import type { OpenDefaults } from "./open.js";
import { CONVENTION_PRESETS, TOOL_PRESETS, toolInstalled } from "./presets.js";

/** "lead" is added by ai-room itself whenever a room has one. */
const CONVENTIONS = Object.keys(CONVENTION_PRESETS).filter((name) => name !== "lead");

export interface SetupQuestion {
  key: keyof OpenDefaults;
  prompt: string;
  suggested: string;
}

const list = (text: string) => text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

/** What each question offers: the current value, or what this machine has installed. */
export function setupQuestions(current: OpenDefaults, has: (bin: string) => boolean = onPath): SetupQuestion[] {
  const installed = Object.keys(LAUNCHERS).filter((name) => has(LAUNCHERS[name].bin));
  const tools = Object.keys(TOOL_PRESETS).filter((name) => toolInstalled(name) === true);
  return [
    {
      key: "invite",
      prompt: installed.length
        ? `Agents a new room invites (found on this machine: ${installed.join(", ")}; claude:2 for two)`
        : `Agents a new room invites (none of ${Object.keys(LAUNCHERS).join(", ")} found on PATH)`,
      suggested: (current.invite ?? installed).join(","),
    },
    { key: "lead", prompt: "Who leads, in order of preference (\"none\" for no lead)", suggested: current.lead === false ? "none" : (current.lead ?? LEAD_PREFERENCE).join(",") },
    { key: "tools", prompt: `Tools declared to every room (${Object.keys(TOOL_PRESETS).join(", ")})`, suggested: (current.tools ?? tools).join(",") },
    { key: "convention", prompt: `Writing conventions (${CONVENTIONS.join(", ")}; empty for none)`, suggested: current.convention ?? "" },
    { key: "mouse", prompt: "Mouse on in the workspace (y/n)", suggested: current.mouse === false ? "n" : "y" },
  ];
}

/** Turns the answers into defaults, refusing names ai-room would reject at open. */
export function defaultsFromAnswers(answers: Partial<Record<keyof OpenDefaults, string>>): OpenDefaults {
  const defaults: OpenDefaults = {};
  const agents = expandInvite(list(answers.invite ?? ""));
  const unknown = agents.filter((agent) => !LAUNCHERS[harnessFor(agent)]);
  if (unknown.length) throw new Error(`unknown agent: ${unknown.join(", ")}. Known: ${Object.keys(LAUNCHERS).join(", ")}`);
  if (agents.length) defaults.invite = agents;

  const lead = list(answers.lead ?? "");
  if (lead.length === 1 && lead[0] === "none") defaults.lead = false;
  else if (lead.length) {
    const bad = lead.filter((name) => !LAUNCHERS[name]);
    if (bad.length) throw new Error(`unknown lead: ${bad.join(", ")}`);
    defaults.lead = lead;
  }

  const tools = list(answers.tools ?? "");
  if (tools.length) defaults.tools = tools;

  const conventions = list(answers.convention ?? "");
  const badConvention = conventions.filter((name) => !CONVENTIONS.includes(name));
  if (badConvention.length) throw new Error(`unknown convention: ${badConvention.join(", ")}. Known: ${CONVENTIONS.join(", ")}`);
  if (conventions.length) defaults.convention = conventions.join(",");

  const mouse = (answers.mouse ?? "").trim().toLowerCase();
  if (mouse) defaults.mouse = !mouse.startsWith("n");
  return defaults;
}

/** Keeps whatever else the file holds; only `defaults` is rewritten. */
export function saveDefaults(defaults: OpenDefaults, file = defaultsPath()): void {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* no file yet */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...config, defaults }, null, 2) + "\n");
}

/** Asks each question with its suggestion; Enter keeps it, a bad name asks again. */
export async function runSetup(file = defaultsPath()): Promise<OpenDefaults> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Defaults for new rooms, saved to ${file}. Enter keeps the suggestion.\n`);
    const answers: Partial<Record<keyof OpenDefaults, string>> = {};
    for (const question of setupQuestions(loadOpenDefaults(file))) {
      for (;;) {
        const answer = (await rl.question(`${question.prompt} [${question.suggested}]: `)).trim();
        answers[question.key] = answer || question.suggested;
        try {
          defaultsFromAnswers({ [question.key]: answers[question.key] });
          break;
        } catch (error) {
          console.log(`  ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    const defaults = defaultsFromAnswers(answers);
    saveDefaults(defaults, file);
    console.log(`\nsaved. Change it any time with: ai-room setup\n`);
    return defaults;
  } finally {
    rl.close();
  }
}

/**
 * The first `open` on a machine with no config offers the questions instead
 * of leaving the defaults to be found by reading the docs. "Not now" asks
 * again next time; "don't ask" saves empty defaults so it never does.
 */
export async function offerSetup(file = defaultsPath()): Promise<void> {
  if (fs.existsSync(file) || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question(
      "No ai-room defaults yet (which agents, lead, tools). Set them up now? [Y]es / [n]ot now / [d]on't ask again: "
    )).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer.startsWith("d")) {
    saveDefaults({}, file);
    console.log("ok, not asking again. Set them up any time with: ai-room setup\n");
  } else if (answer.startsWith("n")) {
    console.log("ok. Set them up any time with: ai-room setup\n");
  } else await runSetup(file);
}
