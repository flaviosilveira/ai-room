import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomCharter, roomJoin, roomSetCharter } from "../src/store.js";
import {
  DRIVERS_FOR_TEST,
  detectMultiplexer,
  ensureWorkspace,
  killWorkspace,
  listTaggedPanes,
  mux,
  paneMenuCommand,
  openInEditorPane,
  paneStates,
  setPaneVisible,
  vimEscape,
  tmuxConfig,
  toggleFilesTab,
  sessionExists,
  sessionName,
  startSession,
  workspaceName,
  workspacePanes,
} from "../src/session.js";
import {
  LAUNCHERS,
  agentCommand,
  closeRoom,
  filesCommand,
  joinPrompt,
  planWorkspace,
  roomSessions,
} from "../src/invite.js";
import { TOOL_CATALOG, TOOL_NAMES } from "../src/catalog.js";

describe("workspace naming and isolation", () => {
  it("gives each room its own workspace session, deterministically", () => {
    expect(workspaceName("refactor-auth")).toMatch(/^airoom-refactor-auth-[0-9a-f]{10}$/);
    expect(workspaceName("a")).not.toBe(workspaceName("b"));
    // Reattach depends on the same room always resolving to the same session.
    expect(workspaceName("refactor-auth")).toBe(workspaceName("refactor-auth"));
  });

  it("keeps rooms distinct even when their slugs are identical", () => {
    // Slugging alone maps all of these to "airoom-refactor-auth", which would
    // drop three different rooms into one workspace.
    const names = ["refactor:auth", "refactor auth", "refactor-auth", "refactor.auth"]
      .map(workspaceName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("emits tmux-safe names for messy room names", () => {
    for (const room of ["OP-3563/auth fix", "teste com espaços", "a:b.c/d"]) {
      expect(workspaceName(room)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never lets a per-agent session collide with a workspace", () => {
    expect(workspaceName("r-codex")).not.toBe(sessionName("r", "codex"));
    expect(sessionName("a", "b-c")).not.toBe(sessionName("a-b", "c"));
  });

  it("counts the detached per-agent sessions as the room's own", () => {
    const owned = roomSessions("refactor-auth");
    expect(owned).toHaveLength(Object.keys(LAUNCHERS).length + 1);
    expect(owned[0]).toEqual({ session: workspaceName("refactor-auth"), agent: null });
    for (const agent of Object.keys(LAUNCHERS)) {
      expect(owned).toContainEqual({ session: sessionName("refactor-auth", agent), agent });
    }
  });

  it("never emits a kill-server command", () => {
    expect(DRIVERS_FOR_TEST.tmux.kill("airoom-r")).toEqual(["kill-session", "-t", "airoom-r"]);
    expect(DRIVERS_FOR_TEST.tmux.kill("airoom-r").join(" ")).not.toContain("kill-server");
  });

  it("only tmux claims pane support", () => {
    expect(DRIVERS_FOR_TEST.tmux.supportsPanes).toBe(true);
    expect(DRIVERS_FOR_TEST.screen.supportsPanes).toBe(false);
  });
});

describe("launch commands", () => {
  it("runs every harness interactively so approval prompts survive", () => {
    expect(agentCommand("r", "claude")).toEqual(["claude", joinPrompt("r", "claude")]);
    expect(agentCommand("r", "codex")).toEqual(["codex", "--approve-for-me", joinPrompt("r", "codex")]);
    expect(agentCommand("r", "agy")).toEqual(["agy", "--mode", "accept-edits", "-i", joinPrompt("r", "agy")]);
  });

  it("tells every launched harness it can go idle and be woken, agy included", () => {
    for (const agent of ["claude", "codex", "agy"]) {
      const prompt = joinPrompt("r", agent);
      expect(prompt).toMatch(/room_idle/);
      expect(prompt).not.toMatch(/cannot be resumed/);
    }
  });

  it("keeps agents on the room, away from each other's panes", () => {
    for (const agent of ["claude", "codex", "agy"]) {
      const prompt = joinPrompt("r", agent);
      expect(prompt).toMatch(/through the room only/);
      expect(prompt).toMatch(/do not read or type into other tmux panes/);
    }
  });

  it("returns null for an unknown harness instead of guessing", () => {
    expect(agentCommand("r", "nope")).toBeNull();
  });

  it("tells the agent that talking to a human is not leaving the room", () => {
    // A direct terminal conversation interrupts room_wait; without this the
    // agent answers the human and silently stops participating.
    const prompt = joinPrompt("r", "codex");
    expect(prompt).toMatch(/that is not leaving the room/);
    expect(prompt).toMatch(/room_leave/);
  });

  it("tells the agent to start working, not to sit in room_wait", () => {
    // The first real session: both agents joined, read the charter and parked.
    // Nothing happened until the human typed "can you work with this?".
    const prompt = joinPrompt("r", "claude");
    expect(prompt).toMatch(/begin the work[\s\S]*immediately/i);
    expect(prompt).toMatch(/without waiting to be told/i);
    expect(prompt).toMatch(/room_send/);
    // Idling is the resting state now; looping on room_wait is what burned a
    // quota window on an empty room.
    expect(prompt).toMatch(/room_idle/);
    expect(prompt).toMatch(/never sit in a room_wait loop/i);
  });

  it("keeps the seed prompt minimal: the charter is fetched, never inlined", () => {
    const prompt = joinPrompt("refactor-auth", "codex");
    expect(prompt).toMatch(/room_join/);
    expect(prompt).toMatch(/room_idle/);
    expect(prompt).toMatch(/briefing/i);
    // The charter's own content must not be duplicated into the prompt.
    expect(prompt).not.toMatch(/caveman|graphify|reviewer|validator/i);
    expect(prompt.length).toBeLessThan(900);
  });
});

describe("workspace planning", () => {
  it("adds a monitor pane alongside the agents", () => {
    const plan = planWorkspace("r", [], { files: false });
    expect(plan.panes.map((p) => p.title)).toEqual(["monitor"]);
    // Must resolve to something runnable: a repo checkout has no ai-room on PATH.
    const [bin, ...rest] = plan.panes[0].command;
    expect(bin === "ai-room" || bin === process.execPath).toBe(true);
    expect(rest).toContain("console");
    expect(rest).toContain("r");
  });

  it("omits the monitor when asked", () => {
    expect(planWorkspace("r", [], { monitor: false, files: false }).panes).toEqual([]);
  });

  it("puts the file browser in a tab of its own", () => {
    const plan = planWorkspace("r", [], { monitor: false, filesCommand: ["yazi"], editorCommand: null });
    expect(plan.panes).toEqual([{ title: "files", command: ["yazi"], window: "files" }]);
  });

  it("puts an editor beside the browser, and points the browser's EDITOR at it", () => {
    const plan = planWorkspace("r", [], { monitor: false, filesCommand: ["yazi"], editorCommand: ["vim"] });
    expect(plan.panes.map((p) => [p.title, p.window, p.beside])).toEqual([
      ["files", "files", undefined],
      ["editor", "files", 70],
    ]);
    expect(plan.panes[0].env?.EDITOR).toMatch(/edit-in-pane$/);
    expect(plan.panes[0].env?.AI_ROOM_WORKSPACE).toBe(workspaceName("r"));
  });

  it("gives a vim-based browser no second editor", () => {
    const plan = planWorkspace("r", [], { monitor: false, filesCommand: ["vim", "-c", "Lexplore"], editorCommand: ["vim"] });
    expect(plan.panes.map((p) => p.title)).toEqual(["files"]);
  });

  it("skips the files tab when no browser is installed", () => {
    expect(planWorkspace("r", [], { monitor: false, filesCommand: null }).panes).toEqual([]);
  });

  it("prefers a real file browser and falls back to vim's tree", () => {
    expect(filesCommand({}, (bin) => bin === "yazi" || bin === "vim")?.[0]).toBe("vim");
    expect(filesCommand({}, (bin) => bin === "yazi")).toEqual(["yazi"]);
    expect(filesCommand({}, (bin) => bin === "vim")?.slice(0, 1)).toEqual(["vim"]);
    expect(filesCommand({}, () => false)).toBeNull();
    expect(filesCommand({ AI_ROOM_FILES: "tree -C | less" }, () => false)).toEqual(["sh", "-c", "tree -C | less"]);
  });

  it("reports harnesses that are not installed instead of failing", () => {
    const plan = planWorkspace("r", ["definitely-not-a-real-agent"], { monitor: false, files: false });
    expect(plan.missing).toEqual(["definitely-not-a-real-agent"]);
    expect(plan.agents).toEqual([]);
    expect(plan.panes).toEqual([]);
  });
});

describe("charter is written before any agent starts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("has the briefing ready for the first room_join", () => {
    roomJoin(db, { room: "r", agent: "human", role: "host" });
    roomSetCharter(db, {
      room: "r",
      brief: "Refatorar auth.",
      conventionPreset: "caveman",
      tools: ["graphify"],
      roster: [{ agent: "codex", role: "reviewer" }],
    });
    // An agent racing to join must already find its role waiting.
    const joined = roomJoin(db, { room: "r", agent: "codex" });
    expect(joined.briefing?.you).toMatchObject({ role: "reviewer" });
    expect(joined.briefing?.conventions).toMatch(/terse/i);
    expect(joined.briefing?.tools[0].name).toBe("graphify");
  });

  it("treats a declared tool as inert data, never as something to run", () => {
    roomJoin(db, { room: "r", agent: "human" });
    // A tool nobody has installed still stores cleanly: declaring is not running,
    // and the server never checks for or invokes what a charter names.
    roomSetCharter(db, {
      room: "r",
      tools: ["graphify", { name: "not-installed-anywhere", purpose: "x" }],
    });
    const tools = roomCharter(db, "r")!.tools;
    expect(tools.map((t) => t.name)).toEqual(["graphify", "not-installed-anywhere"]);
    for (const tool of tools) {
      for (const value of Object.values(tool)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  it("describes graphify as usage guidance, not as a prerequisite", () => {
    roomJoin(db, { room: "r", agent: "human" });
    roomSetCharter(db, { room: "r", tools: ["graphify"] });
    const tool = roomCharter(db, "r")!.tools[0];
    expect(tool.purpose).toBeTruthy();
    expect(tool.howToUse).toMatch(/graphify/);
    // Guidance may mention how to install; it must never order it.
    expect(JSON.stringify(tool)).not.toMatch(/you must install|install it first|required before/i);
  });
});

describe("status on the monitor's border", () => {
  it("shows it next to the pane name, only when there is one", () => {
    expect(tmuxConfig("ai-room")).toContain("#{?@airoom_status, | #{@airoom_status},}");
  });
});

describe("vim paths", () => {
  it("escapes what vim's command line would expand", () => {
    expect(vimEscape("/a b/c%d#e|f.ts")).toBe("/a\\ b/c\\%d\\#e\\|f.ts");
  });
});

describe("workspace tmux config", () => {
  it("binds every way out a human reaches for", () => {
    const config = tmuxConfig();
    expect(config).toContain("bind-key -n F12 detach-client");
    expect(config).toContain("bind-key C-d detach-client");
    expect(config).toContain("bind-key d detach-client");
    expect(config).toMatch(/bind-key X confirm-before .* kill-session/);
    expect(config).toMatch(/bind-key m \{ run-shell .*_pane-menu .*; source-file -F /);
    expect(config).toMatch(/bind-key t run-shell .*_files/);
  });

  it("answers the Ctrl variant of every prefix key, so C-z never suspends the client", () => {
    const config = tmuxConfig("ai-room");
    for (const key of ["m", "t", "z", "x", "d", "q"]) {
      expect(config).toMatch(new RegExp(`^bind-key C-${key} `, "m"));
    }
    expect(config).toContain("bind-key C-z resize-pane -Z");
    // tmux's own lowercase x would kill a single agent's pane.
    expect(config).toMatch(/^bind-key x confirm-before .* kill-session$/m);
    expect(config).toMatch(/^bind-key M \{ set -g mouse/m);
  });

  it("loads in a real tmux without errors", () => {
    if (!tmux) return;
    const file = path.join(os.tmpdir(), `airoom-conf-${process.pid}.conf`);
    fs.writeFileSync(file, tmuxConfig("ai-room"));
    try {
      const result = spawnSync("tmux", ["-L", `airoom-conf-${process.pid}`, "-f", "/dev/null", "start-server", ";", "source-file", file], { encoding: "utf8" });
      expect(result.stderr).toBe("");
    } finally {
      spawnSync("tmux", ["-L", `airoom-conf-${process.pid}`, "kill-server"]);
      fs.rmSync(file, { force: true });
    }
  });

  it("keeps the human's own tmux config underneath", () => {
    const config = tmuxConfig();
    expect(config.indexOf("source-file -q ~/.tmux.conf")).toBeLessThan(config.indexOf("bind-key"));
    expect(config).not.toContain("kill-server");
  });
});

describe("tool catalog", () => {
  it("lists every tool exactly once", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect(TOOL_CATALOG).toHaveLength(13);
  });

  it("marks the read-only tools", () => {
    const readOnly = TOOL_CATALOG.filter((t) => !t.mutates).map((t) => t.name).sort();
    expect(readOnly).toEqual(["room_attachment", "room_charter", "room_history", "room_list", "room_who"]);
  });
});

// Real tmux, skipped automatically where it is absent.
const tmux = detectMultiplexer("tmux");
describe.skipIf(!tmux)("tmux workspace lifecycle (real tmux)", () => {
  const room = `vitest-${process.pid}`;
  const session = workspaceName(room);
  const pane = (title: string) => ({ title, command: ["sh", "-c", "sleep 60"] });

  // Covers the neighbour room too: a failing assertion must not leak a session
  // into the next test, or into the developer's tmux server.
  afterEach(() => {
    if (!tmux) return;
    for (const name of [room, `${room}-other`]) {
      killWorkspace(tmux, workspaceName(name));
      for (const owned of roomSessions(name)) killWorkspace(tmux, owned.session);
    }
  });

  it("creates, extends on reopen, and stays idempotent", () => {
    const first = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);
    expect(first.created).toBe(true);
    expect(first.panes).toEqual(["claude"]);

    const second = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex")]);
    expect(second.created).toBe(false);
    expect(second.panes).toEqual(["codex"]);
    expect(second.skipped).toEqual(["claude"]);
    expect(workspacePanes(tmux!, session).sort()).toEqual(["claude", "codex"]);

    const third = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex")]);
    expect(third.panes).toEqual([]);
  });

  it("reports no workspace when there was nothing to create", () => {
    // `created` used to be "the session did not exist before", so an open with
    // no launchable pane announced a workspace tmux had never heard of, and
    // attach then failed against that name.
    const empty = ensureWorkspace(tmux!, session, process.cwd(), []);
    expect(empty.created).toBe(false);
    expect(sessionExists(tmux!, session)).toBe(false);
  });

  it("reattaches an existing workspace without duplicating panes", () => {
    const first = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("monitor")]);
    expect(first.created).toBe(true);
    // A second `ai-room open <room>` must find everything already running.
    const again = ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("monitor")]);
    expect(again.created).toBe(false);
    expect(again.panes).toEqual([]);
    expect(again.skipped).toEqual(["claude", "monitor"]);
    expect(workspacePanes(tmux!, session).sort()).toEqual(["claude", "monitor"]);
  });

  it("survives agents renaming their own pane title", () => {
    // Codex rewrites its pane title to "[ ! ] Action Required | ai-room".
    // Identity must not depend on anything the agent can overwrite, or
    // reopening a room duplicates every pane.
    const renaming = (title: string) => ({
      title,
      command: ["sh", "-c", `printf '\\033]2;HIJACKED\\033\\\\'; sleep 60`],
    });
    ensureWorkspace(tmux!, session, process.cwd(), [renaming("codex")]);
    const again = ensureWorkspace(tmux!, session, process.cwd(), [renaming("codex")]);
    expect(again.panes).toEqual([]);
    expect(again.skipped).toEqual(["codex"]);
    expect(workspacePanes(tmux!, session)).toEqual(["codex"]);
  });

  it("closes the detached per-agent sessions, not just the workspace", () => {
    // `open --detached` puts every agent in its own session whose name carries
    // a digest, so a workspace-only close orphaned them beyond reach.
    const claude = sessionName(room, "claude");
    const codex = sessionName(room, "codex");
    startSession(tmux!, claude, process.cwd(), ["sh", "-c", "sleep 60"]);
    startSession(tmux!, codex, process.cwd(), ["sh", "-c", "sleep 60"]);
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);

    const closed = closeRoom(room, { driver: tmux });
    expect(closed.map((c) => c.session).sort()).toEqual([claude, codex, session].sort());
    for (const name of [claude, codex, session]) {
      expect(sessionExists(tmux!, name)).toBe(false);
    }
  });

  it("leaves another room's sessions alone when closing one", () => {
    const other = `${room}-other`;
    startSession(tmux!, sessionName(other, "claude"), process.cwd(), ["sh", "-c", "sleep 60"]);
    startSession(tmux!, sessionName(room, "claude"), process.cwd(), ["sh", "-c", "sleep 60"]);

    closeRoom(room, { driver: tmux });
    expect(sessionExists(tmux!, sessionName(room, "claude"))).toBe(false);
    expect(sessionExists(tmux!, sessionName(other, "claude"))).toBe(true);
    killWorkspace(tmux!, sessionName(other, "claude"));
  });

  it("builds every pane in one pass, tagging each and keeping tabs apart", () => {
    const result = ensureWorkspace(
      tmux!,
      session,
      process.cwd(),
      [pane("claude"), pane("codex"), { ...pane("files"), window: "files" }, pane("monitor")],
      { room }
    );
    expect(result.panes.sort()).toEqual(["claude", "codex", "files", "monitor"]);
    expect(listTaggedPanes(tmux!, session).map((p) => p.agent).sort()).toEqual(["claude", "codex", "files", "monitor"]);
    const windows = mux(tmux!, ["list-windows", "-t", session, "-F", "#{window_name}:#{window_panes}"]).out.split("\n");
    expect(windows).toEqual(["agents:3", "files:1"]);
    expect(mux(tmux!, ["show-options", "-v", "-t", session, "@airoom_room"]).out).toBe(room);
  });

  it("hides and shows panes without stopping them", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex"), { ...pane("files"), window: "files" }]);
    const pid = (agent: string) =>
      mux(tmux!, ["display-message", "-p", "-t", paneStates(tmux!, session).find((p) => p.agent === agent)!.paneId, "#{pane_pid}"]).out;
    const before = pid("codex");

    expect(setPaneVisible(tmux!, session, "codex", "toggle")).toMatchObject({ ok: true, hidden: true });
    expect(paneStates(tmux!, session).find((p) => p.agent === "codex")).toMatchObject({ hidden: true, window: "_codex" });
    expect(setPaneVisible(tmux!, session, "codex", "show")).toMatchObject({ ok: true, hidden: false });
    expect(paneStates(tmux!, session).find((p) => p.agent === "codex")).toMatchObject({ hidden: false, window: "agents" });
    expect(pid("codex")).toBe(before);

    // A pane alone in its tab hides by renaming the tab.
    expect(setPaneVisible(tmux!, session, "files", "hide")).toMatchObject({ ok: true, hidden: true });
    expect(setPaneVisible(tmux!, session, "files", "show")).toMatchObject({ ok: true, hidden: false });
    expect(paneStates(tmux!, session).find((p) => p.agent === "files")!.window).toBe("files");

    // Every agent hidden, then a reopen: the new pane still has a window to go to.
    setPaneVisible(tmux!, session, "claude", "hide");
    setPaneVisible(tmux!, session, "codex", "hide");
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("codex"), pane("agy")]);
    expect(paneStates(tmux!, session).find((p) => p.agent === "agy")).toMatchObject({ window: "agents", hidden: false });
    expect(setPaneVisible(tmux!, session, "codex", "show")).toMatchObject({ ok: true });
    expect(setPaneVisible(tmux!, session, "nobody", "show").ok).toBe(false);
  });

  it("jumps to the files tab, showing it first when hidden", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), { ...pane("files"), window: "files" }]);
    const current = () => mux(tmux!, ["display-message", "-p", "-t", session, "#{window_name}"]).out;
    expect(current()).toBe("agents");
    expect(toggleFilesTab(tmux!, session, "agents").ok).toBe(true);
    expect(current()).toBe("files");

    setPaneVisible(tmux!, session, "files", "hide");
    expect(toggleFilesTab(tmux!, session, "agents").ok).toBe(true);
    expect(paneStates(tmux!, session).find((p) => p.agent === "files")).toMatchObject({ hidden: false });
    expect(current()).toBe("files");
  });

  it("builds the files tab as browser beside editor, and sends picked files to the editor", async () => {
    const sink = path.join(os.tmpdir(), `airoom-editor-${process.pid}.txt`);
    ensureWorkspace(tmux!, session, process.cwd(), [
      pane("claude"),
      { ...pane("files"), window: "files" },
      { title: "editor", command: ["sh", "-c", `cat > ${sink}`], window: "files", beside: 70 },
    ]);
    const windows = mux(tmux!, ["list-windows", "-t", session, "-F", "#{window_name}:#{window_panes}"]).out.split("\n");
    expect(windows).toEqual(["agents:1", "files:2"]);
    const active = mux(tmux!, ["display-message", "-p", "-t", `=${session}:files`, "#{@airoom_agent}"]).out;
    expect(active).toBe("files");

    expect(openInEditorPane(tmux!, session, ["/tmp/my file.ts"]).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fs.readFileSync(sink, "utf8")).toContain(":e /tmp/my\\ file.ts");
    fs.rmSync(sink, { force: true });
  });

  it("brings the editor back beside the browser after it was quit", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), { ...pane("files"), window: "files" }]);
    expect(openInEditorPane(tmux!, session, ["/tmp/a.ts"], ["sh", "-c", "sleep 30"]).ok).toBe(true);
    const editor = paneStates(tmux!, session).find((p) => p.agent === "editor");
    expect(editor).toMatchObject({ window: "files", home: "files" });
  });

  it("builds a pane menu tmux accepts", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude"), pane("monitor")]);
    const command = paneMenuCommand(session, paneStates(tmux!, session), "'/x/node' '/x/cli.js'");
    expect(command).toContain('"[x] claude"');
    expect(command).toContain('"[x] human (monitor)"');
    // Parsed by tmux itself: a syntax error surfaces here, not at the keypress.
    const file = path.join(os.tmpdir(), `airoom-menu-${process.pid}.tmux`);
    fs.writeFileSync(file, `if-shell -F 0 { ${command} }\n`);
    try {
      expect(mux(tmux!, ["source-file", file]).ok).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("keeps an argument ending in a semicolon intact", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [
      { title: "claude", command: ["sh", "-c", "sleep 60; echo fim;"] },
    ]);
    expect(workspacePanes(tmux!, session)).toEqual(["claude"]);
  });

  it("keeps rooms in separate sessions", () => {
    const other = workspaceName(`${room}-other`);
    ensureWorkspace(tmux!, session, process.cwd(), [pane("a")]);
    ensureWorkspace(tmux!, other, process.cwd(), [pane("a")]);
    expect(sessionExists(tmux!, session)).toBe(true);
    expect(sessionExists(tmux!, other)).toBe(true);

    killWorkspace(tmux!, other);
    // Closing one workspace must not touch the other.
    expect(sessionExists(tmux!, other)).toBe(false);
    expect(sessionExists(tmux!, session)).toBe(true);
  });
});
