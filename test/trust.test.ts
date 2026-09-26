import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trustFolder } from "../src/invite.js";

describe("trustFolder", () => {
  it("trusts the folder once for the harnesses being launched, keeping the rest of their config", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "trust-home-"));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-dir-")));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ theme: "dark", projects: { "/elsewhere": { x: 1 } } }));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "o"\n');

    expect(trustFolder(dir, new Set(["claude", "codex"]), home)).toEqual(["claude", "codex"]);
    expect(trustFolder(dir, new Set(["claude", "codex"]), home)).toEqual([]);

    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.projects["/elsewhere"]).toEqual({ x: 1 });
    expect(claude.projects[dir].hasTrustDialogAccepted).toBe(true);
    const codex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('model = "o"');
    expect(codex.split(`[projects.${JSON.stringify(dir)}]`)).toHaveLength(2);
  });

  it("leaves alone a folder under one already trusted, and harnesses not launched", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "trust-home-"));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-dir-")));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [path.dirname(dir)]: { hasTrustDialogAccepted: true } } }));
    expect(trustFolder(dir, new Set(["claude", "agy"]), home)).toEqual([]);
  });
});
