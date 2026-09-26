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

describe("the composer puts pastes in the line as tokens", () => {
  it("sends typed text exactly as before", () => {
    expect(new Composer().takeAll("  oi time  ")).toEqual({ message: "oi time", attachmentIds: [] });
  });

  it("puts a paste back where its token sits, line breaks intact", () => {
    const composer = new Composer();
    const token = composer.stage("linha 1\nlinha 2\nlinha 3\n");
    expect(token).toBe("[Pasted #1: 3 lines]");
    const { message } = composer.takeAll(`olha isso: ${token} e me diga`);
    expect(message).toBe("olha isso:\nlinha 1\nlinha 2\nlinha 3\ne me diga");
  });

  it("keeps a one-line paste inline, and several pastes in their order", () => {
    const composer = new Composer();
    const a = composer.stage("abc");
    const b = composer.stage("x\ny");
    expect(a).toBe("[Pasted #1: 3 chars]");
    expect(composer.takeAll(`${b} antes de ${a}`).message).toBe("x\ny\nantes de abc");
  });

  it("leaves out an item whose token was deleted, and never echoes a paste", () => {
    const composer = new Composer();
    composer.stage("segredo que sumiu");
    expect(composer.takeAll("só texto")).toEqual({ message: "só texto", attachmentIds: [] });
    expect(composer.empty).toBe(true);
  });

  it("removes a whole token on one Backspace", () => {
    const composer = new Composer();
    const token = composer.stage("abc");
    expect(composer.backspaceWidth(`olha ${token}`)).toBe(token.length);
    expect(composer.backspaceWidth("olha ")).toBe(1);
  });

  it("drops and discards on request", () => {
    const composer = new Composer();
    composer.stage("a");
    expect(composer.drop(1)).toBe("[Pasted #1: 1 chars]");
    expect(composer.drop(9)).toBeNull();
    composer.stage("b");
    composer.clear();
    expect(composer.empty).toBe(true);
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
