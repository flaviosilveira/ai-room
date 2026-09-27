import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultsFromAnswers, saveDefaults, setupQuestions } from "../src/setup.js";
import { loadOpenDefaults } from "../src/open.js";

describe("setup", () => {
  it("suggests the agents installed here when nothing is configured", () => {
    const invite = setupQuestions({}, (bin) => bin === "claude" || bin === "codex").find((q) => q.key === "invite")!;
    expect(invite.suggested).toBe("claude,codex");
    expect(setupQuestions({ invite: ["agy"] }, () => true).find((q) => q.key === "invite")!.suggested).toBe("agy");
  });

  it("turns answers into defaults and refuses names open would reject", () => {
    expect(defaultsFromAnswers({ invite: "claude, codex:2", lead: "none", convention: "caveman", mouse: "n" })).toEqual({
      invite: ["claude", "codex", "codex-2"],
      lead: false,
      convention: "caveman",
      mouse: false,
    });
    expect(() => defaultsFromAnswers({ invite: "claud" })).toThrow(/unknown agent/);
    expect(() => defaultsFromAnswers({ convention: "lead" })).toThrow(/unknown convention/);
  });

  it("rewrites only the defaults, keeping the rest of the file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "airoom-setup-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({ other: 1, defaults: { mouse: false } }));
    saveDefaults({ invite: ["claude", "agy"] }, file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).other).toBe(1);
    expect(loadOpenDefaults(file)).toMatchObject({ invite: ["claude", "agy"] });
  });
});
