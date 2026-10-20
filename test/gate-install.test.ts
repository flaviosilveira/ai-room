import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateStatus, installGate, policyPath, uninstallGate } from "../src/gate.js";
import { gateInstalled } from "../src/invite.js";

describe("ai-room gate install", () => {
  let home: string;
  const read = (relative: string) => JSON.parse(fs.readFileSync(path.join(home, relative), "utf8"));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-gate-home-"));
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt"\n');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("installs into all three harnesses, keeps what was there, and writes a policy once", () => {
    installGate(home);
    expect(gateStatus(home).every((s) => s.installed)).toBe(true);
    const claude = read(".claude/settings.json");
    expect(claude.model).toBe("x");
    expect(claude.hooks.PreToolUse).toHaveLength(2);
    expect(read(".codex/hooks.json").hooks.PreToolUse[0].matcher).toBe("");
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toMatch(/\[features\]\nhooks = true/);
    expect(read(".gemini/config/hooks.json")["ai-room-gate"].PreToolUse[0].hooks[0].command).toMatch(/ai-room-gate\.py --harness agy/);
    expect(JSON.parse(fs.readFileSync(policyPath(home), "utf8")).ask).toContain("terraform apply");

    fs.writeFileSync(policyPath(home), JSON.stringify({ allow: [], ask: ["mine"], deny: [] }));
    expect(installGate(home)).toContain("claude: already installed");
    expect(JSON.parse(fs.readFileSync(policyPath(home), "utf8")).ask).toEqual(["mine"]);
    expect(read(".claude/settings.json").hooks.PreToolUse).toHaveLength(2);
  });

  it("is what makes ai-room skip a harness's prompts, and comes off cleanly", () => {
    const previous = process.env.AI_ROOM_HOOKS_HOME;
    process.env.AI_ROOM_HOOKS_HOME = home;
    try {
      expect(gateInstalled("claude")).toBe(false);
      installGate(home);
      expect(gateInstalled("claude")).toBe(true);
      expect(gateInstalled("agy")).toBe(true);
      uninstallGate(home);
      expect(gateInstalled("claude")).toBe(false);
      expect(gateInstalled("agy")).toBe(false);
      expect(read(".claude/settings.json").hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }]);
    } finally {
      process.env.AI_ROOM_HOOKS_HOME = previous;
    }
  });
});
