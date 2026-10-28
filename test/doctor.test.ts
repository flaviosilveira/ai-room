import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_NAMES } from "../src/catalog.js";
import { codexToolApprovals, renderChecks, runChecks } from "../src/doctor.js";

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

  it("names the ai-room tools Codex still asks about, only for those who approve per tool", () => {
    expect(codexToolApprovals('[mcp_servers.ai-room]\nurl = "x"\n')).toBeNull();
    const partial = codexToolApprovals('[mcp_servers.ai-room.tools.room_join]\napproval_mode = "approve"\n')!;
    expect(partial.level).toBe("warn");
    expect(partial.detail).toMatch(/room_summary/);
    expect(partial.fix).toContain('[mcp_servers.ai-room.tools.room_summary] approval_mode = "approve"');
    const all = TOOL_NAMES.map((name) => `[mcp_servers.ai-room.tools.${name}]\napproval_mode = "approve"`).join("\n");
    expect(codexToolApprovals(all)!.level).toBe("ok");
  });
});
