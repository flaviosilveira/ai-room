import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderChecks, runChecks } from "../src/doctor.js";

describe("ai-room doctor", () => {
  it("reports an unreachable server as the one real problem, with its fix", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-doctor-"));
    try {
      const checks = await runChecks(1, home);
      const server = checks.find((c) => c.name === "server")!;
      expect(server).toMatchObject({ level: "fail", fix: "ai-room service install" });
      expect(checks.filter((c) => c.section === "tools").every((c) => c.level !== "fail")).toBe(true);
      expect(renderChecks(checks)).toMatch(/→ ai-room service install/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
