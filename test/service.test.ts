import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCH_LABEL, launchAgentPlist, systemdUnit } from "../src/service.js";

const spec = {
  node: "/Users/me/.asdf/installs/nodejs/24.15.0/bin/node",
  cli: "/Users/me/dev/ai room/dist/cli.js",
  cwd: "/Users/me/dev/ai room",
  port: 49375,
  home: "/Users/me",
  logDir: "/Users/me/.ai-room/logs",
};

describe("user service files", () => {
  it("pins node and runs serve directly under launchd", () => {
    const plist = launchAgentPlist(spec);
    expect(plist).toContain(`<string>${LAUNCH_LABEL}</string>`);
    expect(plist).toContain(`<string>${spec.node}</string>`);
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("/Users/me/.asdf/installs/nodejs/24.15.0/bin:/opt/homebrew/bin");
  });

  it.skipIf(process.platform !== "darwin")("writes a plist macOS accepts", () => {
    const file = path.join(os.tmpdir(), `airoom-${process.pid}.plist`);
    fs.writeFileSync(file, launchAgentPlist({ ...spec, cwd: "/a & <b>" }));
    try {
      expect(spawnSync("plutil", ["-lint", file]).status).toBe(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("quotes paths with spaces in the systemd unit", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain(`ExecStart="${spec.node}" "${spec.cli}" serve`);
    expect(unit).toContain("Restart=on-failure");
  });
});
