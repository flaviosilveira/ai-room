import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills, parseSkillFrontmatter, renderSkills } from "../src/skills.js";
import { completeSlash } from "../src/console.js";

const skill = (dir: string, name: string, description: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
};

describe("skill frontmatter", () => {
  it("reads inline and folded descriptions", () => {
    expect(parseSkillFrontmatter("---\nname: a\ndescription: \"Short one\"\n---\n")).toEqual({ name: "a", description: "Short one" });
    expect(parseSkillFrontmatter("---\nname: b\ndescription: >\n  First line\n  second line\nlicense: MIT\n---\n")).toEqual({
      name: "b",
      description: "First line second line",
    });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({});
  });
});

describe("skill discovery", () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-proj-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-home-"));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds project, user and plugin skills, the project one winning a name clash", () => {
    skill(path.join(cwd, ".claude/skills/deploy-check"), "deploy-check", "Validates the deploy");
    skill(path.join(cwd, ".agents/skills/grill-me"), "grill-me", "The project's own grill");
    skill(path.join(home, ".agents/skills/grill-me"), "grill-me", "The user's grill");
    const plugin = path.join(home, "plugin-cache/tdd/1.0");
    skill(path.join(plugin, "skills/engineering/tdd"), "tdd", "Test first");
    fs.mkdirSync(path.join(home, ".claude/plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "tdd@market": [{ installPath: plugin }] } })
    );

    const found = discoverSkills(cwd, home);
    expect(found.map((s) => [s.name, s.source]).sort()).toEqual([
      ["deploy-check", "project"],
      ["grill-me", "project"],
      ["tdd", "plugin"],
    ]);
    expect(found.find((s) => s.name === "grill-me")!.description).toBe("The project's own grill");
    expect(renderSkills(found, 80)).toMatch(/^projeto \(2\)/);
  });

  it("works with no skills anywhere", () => {
    expect(discoverSkills(cwd, home)).toEqual([]);
    expect(renderSkills([])).toMatch(/nenhuma skill/);
  });
});

describe("slash completion", () => {
  const skills = [{ name: "grill-me" }, { name: "grill-with-docs" }];

  it("completes commands and skills after a slash", () => {
    expect(completeSlash("/gr", skills)[0]).toEqual(["/grill-me", "/grill-with-docs"]);
    expect(completeSlash("/ski", skills)[0]).toEqual(["/skills"]);
  });

  it("leaves ordinary text and arguments alone", () => {
    expect(completeSlash("olha isso", skills)[0]).toEqual([]);
    expect(completeSlash("/file ~/Desk", skills)[0]).toEqual([]);
  });
});
