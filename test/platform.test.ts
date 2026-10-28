import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeDir, claudeJson, codexDir, onPath, pathDirs } from "../src/platform.js";
import { pastedFilePath } from "../src/clipboard.js";

describe("platform differences", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ignores Windows programs on the WSL PATH, except .exe tools", () => {
    const PATH = ["/usr/bin", "/mnt/c/Users/me/AppData/Roaming/npm", "/mnt/c/Windows/System32"].join(path.delimiter);
    expect(pathDirs("codex", { PATH })).toHaveLength(3);
    expect(pathDirs("codex", { PATH, WSL_DISTRO_NAME: "Ubuntu" })).toEqual(["/usr/bin"]);
    expect(pathDirs("clip.exe", { PATH, WSL_DISTRO_NAME: "Ubuntu" })).toHaveLength(3);
    expect(onPath("node")).toBe(true);
  });

  it("maps a file dropped from Windows Terminal through wslpath", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-drop-"));
    const file = path.join(dir, "shot one.png");
    fs.writeFileSync(file, "x");
    try {
      const run = (bin: string, args: string[]) => ({ status: 0, stdout: Buffer.from(bin === "wslpath" && args[1] === "C:\\Users\\me\\shot one.png" ? `${file}\n` : "") });
      expect(pastedFilePath("C:\\Users\\me\\shot one.png", run)).toBeNull();
      vi.stubEnv("WSL_INTEROP", "/run/WSL/1_interop");
      expect(pastedFilePath("C:\\Users\\me\\shot one.png", run)).toBe(file);
      expect(pastedFilePath('"C:\\Users\\me\\shot one.png"', run)).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    expect(claudeDir("/h")).toBe("/h/.claude");
    expect(claudeJson("/h")).toBe("/h/.claude.json");
    expect(codexDir("/h")).toBe("/h/.codex");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/x/claude");
    vi.stubEnv("CODEX_HOME", "/x/codex");
    expect(claudeDir("/h")).toBe("/x/claude");
    expect(claudeJson("/h")).toBe("/x/claude/.claude.json");
    expect(codexDir("/h")).toBe("/x/codex");
  });
});
