import { describe, expect, it } from "vitest";
import { DRIVERS_FOR_TEST, sessionName } from "../src/session.js";

describe("session naming", () => {
  it("strips characters tmux and screen reject", () => {
    expect(sessionName("minha.sala:teste", "codex")).toMatch(
      /^airoom-minha-sala-teste-codex-[0-9a-f]{10}$/
    );
    expect(sessionName("a/b c", "ag y")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("keeps rooms and agents distinguishable", () => {
    expect(sessionName("r1", "codex")).not.toBe(sessionName("r1", "agy"));
    expect(sessionName("r1", "codex")).not.toBe(sessionName("r2", "codex"));
  });
});

describe("multiplexer drivers", () => {
  it("builds a detached start command for tmux with an explicit cwd", () => {
    const argv = DRIVERS_FOR_TEST.tmux.start("s", "/tmp", ["codex", "hello"]);
    expect(argv).toEqual(["new-session", "-d", "-s", "s", "-c", "/tmp", "codex", "hello"]);
  });

  it("builds a detached start command for screen", () => {
    expect(DRIVERS_FOR_TEST.screen.start("s", "/tmp", ["codex", "hello"])).toEqual([
      "-dmS", "s", "codex", "hello",
    ]);
  });

  it("parses tmux session listings", () => {
    expect(DRIVERS_FOR_TEST.tmux.parseList("airoom-r-codex\nairoom-r-agy\n")).toEqual([
      "airoom-r-codex", "airoom-r-agy",
    ]);
  });

  it("parses the noisier screen -ls output", () => {
    const out = [
      "There are screens on:",
      "\t12345.airoom-r-codex\t(Detached)",
      "\t12346.airoom-r-agy\t(Detached)",
      "2 Sockets in /run/screen/S-user.",
    ].join("\n");
    expect(DRIVERS_FOR_TEST.screen.parseList(out)).toEqual(["airoom-r-codex", "airoom-r-agy"]);
  });

  it("returns nothing when no sessions exist", () => {
    expect(DRIVERS_FOR_TEST.screen.parseList("No Sockets found in /run/screen/S-user.")).toEqual([]);
    expect(DRIVERS_FOR_TEST.tmux.parseList("")).toEqual([]);
  });
});
