import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs `ai-room serve` as a user service: a LaunchAgent on macOS, a systemd
 * user unit on Linux. Never as root, never touching ~/.ai-room state.
 *
 * The service file pins the node binary running this command. A version
 * manager resolves node per directory, and a service starts with a minimal
 * PATH, so "node" alone would be a different runtime or none at all.
 */
export const LAUNCH_LABEL = "local.ai-room";
export const SERVICE_NAME = "ai-room";

export interface ServiceSpec {
  node: string;
  cli: string;
  cwd: string;
  port: number;
  home: string;
  logDir: string;
}

export function serviceSpec(port: number): ServiceSpec {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  return {
    node: process.execPath,
    cli,
    cwd: path.dirname(path.dirname(cli)),
    port,
    home: os.homedir(),
    logDir: path.join(os.homedir(), ".ai-room", "logs"),
  };
}

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** tmux is found through its own fallbacks; the PATH only has to reach node. */
const servicePath = (node: string) =>
  [path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export function launchAgentPlist(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.cli)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(spec.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath(spec.node))}</string>
    <key>AI_ROOM_PORT</key><string>${spec.port}</string>
    <key>HOME</key><string>${xml(spec.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(spec.logDir, "ai-room.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(spec.logDir, "ai-room.err.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

const unitQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=ai-room local MCP server
Documentation=https://github.com/flaviosilveira/ai-room
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.cwd}
Environment=${unitQuote(`PATH=${servicePath(spec.node)}`)}
Environment=AI_ROOM_PORT=${spec.port}
ExecStart=${unitQuote(spec.node)} ${unitQuote(spec.cli)} serve
Restart=on-failure
RestartSec=10
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=default.target
`;
}

type Platform = "launchd" | "systemd" | "none";

function platform(): Platform {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    const probe = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
    return probe.status === 0 ? "systemd" : "none";
  }
  return "none";
}

const plistPath = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
const unitPath = () => path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;

function run(bin: string, args: string[], quiet = true): boolean {
  return spawnSync(bin, args, { stdio: quiet ? "ignore" : "inherit" }).status === 0;
}

const ok = (line: string) => console.log(`  ✓ ${line}`);
const warn = (line: string) => console.log(`  ! ${line}`);
const fail = (line: string) => {
  console.log(`  ✗ ${line}`);
  process.exitCode = 1;
};

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The service manager relaunches the server a few seconds after a restart, so
 * "restarted" alone left a window where every client saw a dead port.
 */
async function waitReady(port: number, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await answers(port)) {
      ok(`answering on port ${port} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`port ${port} still not answering after ${timeoutMs / 1000}s: ai-room service logs`);
}

/** Writes the file only when it changed, so reinstalling a current service never restarts it. */
function writeIfChanged(file: string, content: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, content, { mode: 0o644 });
  return true;
}

const USAGE = "usage: ai-room service <install|status|start|stop|restart|logs|uninstall>";

export async function service(action: string | undefined, port: number): Promise<void> {
  const where = platform();
  if (action === undefined || !["install", "status", "start", "stop", "restart", "logs", "uninstall"].includes(action)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (where === "none") {
    warn(`no service manager here (${process.platform}); run the server yourself: ai-room serve`);
    if (action === "status") (await answers(port)) ? ok(`port ${port} answering`) : fail(`port ${port} not answering`);
    return;
  }
  if (action === "install" && process.getuid?.() === 0) {
    fail("refusing to install this service as root");
    return;
  }

  if (where === "launchd") {
    const file = plistPath();
    const target = `${domain()}/${LAUNCH_LABEL}`;
    switch (action) {
      case "install": {
        const spec = serviceSpec(port);
        fs.mkdirSync(spec.logDir, { recursive: true });
        const changed = writeIfChanged(file, launchAgentPlist(spec));
        if (changed) {
          run("launchctl", ["bootout", target]);
          run("launchctl", ["bootstrap", domain(), file])
            ? ok(`LaunchAgent installed and started (${file})`)
            : fail("launchctl bootstrap failed");
        } else {
          ok("LaunchAgent already up to date");
          if (!run("launchctl", ["print", target])) run("launchctl", ["bootstrap", domain(), file]);
        }
        ok(`node pinned: ${spec.node}`);
        await waitReady(port);
        break;
      }
      case "status": {
        fs.existsSync(file) ? ok(`LaunchAgent installed (${file})`) : fail("LaunchAgent not installed: ai-room service install");
        const printed = spawnSync("launchctl", ["print", target], { encoding: "utf8" });
        const pid = printed.status === 0 ? /\n\s*pid = (\d+)/.exec(printed.stdout)?.[1] : undefined;
        if (printed.status !== 0) fail("service not loaded");
        else pid ? ok(`service running (pid ${pid})`) : warn("service loaded but not running");
        (await answers(port)) ? ok(`port ${port} answering`) : fail(`port ${port} not answering`);
        break;
      }
      case "start":
        if (!fs.existsSync(file)) return fail("not installed: ai-room service install");
        run("launchctl", ["bootstrap", domain(), file]) || run("launchctl", ["kickstart", target]);
        ok("started");
        await waitReady(port);
        break;
      case "stop":
        run("launchctl", ["bootout", target]) ? ok("stopped") : warn("was not running");
        break;
      case "restart":
        if (!run("launchctl", ["kickstart", "-k", target])) return fail("not loaded: ai-room service start");
        ok("restarted");
        await waitReady(port);
        break;
      case "logs": {
        const logs = serviceSpec(port).logDir;
        run("tail", ["-n", "50", "-F", path.join(logs, "ai-room.out.log"), path.join(logs, "ai-room.err.log")], false);
        break;
      }
      case "uninstall":
        run("launchctl", ["bootout", target]);
        if (fs.existsSync(file)) fs.rmSync(file);
        ok("LaunchAgent removed; the database, rooms and agent configuration are untouched");
        break;
    }
    return;
  }

  const file = unitPath();
  const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
  switch (action) {
    case "install": {
      const spec = serviceSpec(port);
      if (writeIfChanged(file, systemdUnit(spec))) {
        systemctl("daemon-reload");
        ok(`systemd unit installed (${file})`);
      } else ok("systemd unit already up to date");
      systemctl("enable", "--now", SERVICE_NAME) ? ok("service enabled and started") : fail(`could not enable: systemctl --user status ${SERVICE_NAME}`);
      ok(`node pinned: ${spec.node}`);
      break;
    }
    case "status":
      fs.existsSync(file) ? ok(`systemd unit installed (${file})`) : fail("systemd unit not installed: ai-room service install");
      systemctl("is-active", "--quiet", SERVICE_NAME) ? ok("service active") : fail("service not active");
      (await answers(port)) ? ok(`port ${port} answering`) : fail(`port ${port} not answering`);
      break;
    case "start":
    case "stop":
    case "restart":
      if (!systemctl(action, SERVICE_NAME)) return fail(`systemctl --user ${action} failed`);
      ok(action === "stop" ? "stopped" : `${action}ed`);
      if (action !== "stop") await waitReady(port);
      break;
    case "logs":
      run("journalctl", ["--user", "-u", SERVICE_NAME, "-n", "50", "-f"], false);
      break;
    case "uninstall":
      systemctl("disable", "--now", SERVICE_NAME);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        systemctl("daemon-reload");
      }
      ok("systemd unit removed; the database, rooms and agent configuration are untouched");
      break;
  }
}
