import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import {
  MAX_PASTE_BYTES,
  PASTE_END,
  PASTE_START,
  PasteFilter,
  createPasteStream,
  normalizePaste,
} from "../src/paste.js";
import { Composer } from "../src/console.js";
import {
  clipboardCommand,
  detectMultiplexer,
  ensureWorkspace,
  killWorkspace,
  workspaceName,
  tmuxArgv,
} from "../src/session.js";
import { parseOpenFlags } from "../src/open.js";

const bracket = (text: string) => `${PASTE_START}${text}${PASTE_END}`;

describe("a paste keeps its boundary", () => {
  it("separates a whole paste from ordinary typing", () => {
    const filter = new PasteFilter();
    const result = filter.feed(`ola${bracket("um\rdois\rtres")}tchau`);
    expect(result.pastes).toEqual(["um\ndois\ntres"]);
    expect(result.forward).toBe("olatchau");
  });

  it("carries a paste split across reads", () => {
    const filter = new PasteFilter();
    const whole = bracket("primeira\nsegunda\nterceira");
    let from = 0;
    const pastes: string[] = [];
    let forward = "";
    for (const to of [7, 15, 24, whole.length]) {
      const r = filter.feed(whole.slice(from, to));
      pastes.push(...r.pastes);
      forward += r.forward;
      from = to;
    }
    expect(pastes).toEqual(["primeira\nsegunda\nterceira"]);
    expect(forward).toBe("");
  });

  it("recognises a marker cut in half between chunks", () => {
    const filter = new PasteFilter();
    const first = filter.feed("texto" + PASTE_START.slice(0, 4));
    expect(first.forward).toBe("texto");
    const second = filter.feed(PASTE_START.slice(4) + "colado" + PASTE_END);
    expect(second.pastes).toEqual(["colado"]);
  });

  it("keeps several pastes in one read apart", () => {
    const filter = new PasteFilter();
    const r = filter.feed(`${bracket("a\nb")}x${bracket("c\nd")}`);
    expect(r.pastes).toEqual(["a\nb", "c\nd"]);
    expect(r.forward).toBe("x");
  });

  it("gives up on an unbounded paste instead of growing forever", () => {
    const filter = new PasteFilter();
    const huge = "x".repeat(MAX_PASTE_BYTES + 10);
    const r = filter.feed(PASTE_START + huge);
    expect(r.pastes).toEqual([]);
    expect(r.forward.length).toBeGreaterThan(MAX_PASTE_BYTES);
    expect(filter.buffering).toBe(false);
  });

  it("normalises the line endings a terminal sends", () => {
    expect(normalizePaste("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("never lets readline see the pasted lines", async () => {
    // The regression: readline turned one paste into one line event per line.
    const stream = createPasteStream();
    const pastes: string[] = [];
    stream.on("paste", (p: string) => pastes.push(p));
    const rl = readline.createInterface({ input: stream, output: new PassThrough(), terminal: true });
    const lines: string[] = [];
    rl.on("line", (l) => lines.push(l));

    stream.write(bracket("uma\rduas\rtres"));
    stream.write("digitado\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pastes).toEqual(["uma\nduas\ntres"]);
    expect(lines).toEqual(["digitado"]);
    rl.close();
  });
});

describe("the composer makes one message", () => {
  it("sends typed text exactly as before", () => {
    const composer = new Composer();
    expect(composer.pending).toBe(0);
    expect(composer.take("mensagem normal")).toBe("mensagem normal");
  });

  it("turns a paste into a single message with its line breaks", () => {
    const composer = new Composer();
    composer.stage("linha 1\nlinha 2\nlinha 3");
    const message = composer.take("");
    expect(message).toBe("linha 1\nlinha 2\nlinha 3");
    expect(message.split("\n")).toHaveLength(3);
    expect(composer.pending).toBe(0);
  });

  it("joins a caption and a paste in the same message", () => {
    const composer = new Composer();
    composer.stage("erro na linha 4\nstack trace aqui");
    expect(composer.take("olha isso:")).toBe("olha isso:\n\nerro na linha 4\nstack trace aqui");
  });

  it("keeps several pastes in one message", () => {
    const composer = new Composer();
    composer.stage("bloco A");
    composer.stage("bloco B");
    expect(composer.pending).toBe(2);
    expect(composer.take("")).toBe("bloco A\n\nbloco B");
  });

  it("describes a paste without echoing it", () => {
    const composer = new Composer();
    const summary = composer.summary("a\nb\nc");
    expect(summary).toBe("[colado: 3 linhas, 5 chars]");
    expect(summary).not.toContain("\n");
  });

  it("drops the newline that closed the paste", () => {
    const composer = new Composer();
    composer.stage("linha um\nlinha dois\n");
    expect(composer.take("")).toBe("linha um\nlinha dois");
  });

  it("discards the draft on request", () => {
    const composer = new Composer();
    composer.stage("nao era pra colar");
    composer.clear();
    expect(composer.pending).toBe(0);
    expect(composer.take("outra coisa")).toBe("outra coisa");
  });
});

describe("mouse is on by default and copying still works", () => {
  it("leaves the choice to the defaults unless a flag decides", () => {
    expect(parseOpenFlags([]).mouse).toBeUndefined();
    expect(parseOpenFlags(["--mouse"]).mouse).toBe(true);
    expect(parseOpenFlags(["--no-mouse"]).mouse).toBe(false);
  });

  it("pipes a selection into the local clipboard tool", () => {
    expect(clipboardCommand("darwin", {}, (b) => b === "pbcopy")).toBe("pbcopy");
    expect(clipboardCommand("darwin", {}, () => false)).toBeNull();
    expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }, (b) => b === "wl-copy")).toBe(
      "wl-copy"
    );
    expect(clipboardCommand("linux", {}, (b) => b === "xclip")).toBe("xclip -selection clipboard -in");
    expect(clipboardCommand("linux", {}, () => false)).toBeNull();
  });
});

const tmux = detectMultiplexer("tmux");
describe.skipIf(!tmux)("workspace mouse settings against real tmux", () => {
  const room = `vitest-mouse-${process.pid}`;
  const session = workspaceName(room);
  const pane = (title: string) => ({ title, command: ["sh", "-c", "sleep 30"] });
  const option = (name: string) =>
    `${spawnSync(...tmuxArgv(["show-options", "-t", session, name]), { encoding: "utf8" }).stdout ?? ""}`.trim();

  afterEach(() => {
    if (tmux) killWorkspace(tmux, session);
  });

  it("leaves the mouse alone by default", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")]);
    // Nothing set on the session means the human's own default wins.
    expect(option("mouse")).not.toMatch(/mouse on/);
  });

  it("turns it on with a copy binding when asked", () => {
    ensureWorkspace(tmux!, session, process.cwd(), [pane("claude")], { mouse: true });
    expect(option("mouse")).toMatch(/mouse on/);
    const bindings = `${spawnSync(...tmuxArgv(["list-keys", "-T", "copy-mode"]), { encoding: "utf8" }).stdout ?? ""}`;
    expect(bindings).toMatch(/MouseDragEnd1Pane.*copy-pipe-and-cancel/);
  });
});
