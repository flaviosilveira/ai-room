import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/index.js";
import { roomHistory, roomJoin, roomSend, searchMessages } from "../src/store.js";
import { searchLine, snippet } from "../src/search.js";

describe("searching the rooms' history", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
    for (const room of ["alpha", "beta"]) {
      roomJoin(db, { room, agent: "claude" });
      roomJoin(db, { room, agent: "codex" });
    }
    roomSend(db, { room: "alpha", agent: "claude", message: "Opened https://github.com/acme/app/pull/3126 for the posting fix" });
    // Pushes the PR message out of the newest 100, where `messages` used to stop.
    for (let i = 0; i < 120; i += 1) roomSend(db, { room: "alpha", agent: "codex", message: `progress ${i}` });
    roomSend(db, { room: "beta", agent: "codex", message: "Reviewed PULL/3126 and left two comments" });
    roomSend(db, { room: "beta", agent: "claude", message: "Coverage went to 100% on the parser" });
    roomSend(db, { room: "beta", agent: "claude", message: "Coverage went to 100 on the parser" });
  });
  afterEach(() => db.close());

  it("finds a match across rooms, oldest first, even past the newest 100", () => {
    expect(roomHistory(db, { room: "alpha", limit: 100 }).some((m) => m.content.includes("pull/3126"))).toBe(false);
    const { messages, total } = searchMessages(db, { text: "pull/3126" });
    expect(total).toBe(2);
    expect(messages.map((m) => [m.room, m.agent])).toEqual([
      ["alpha", "claude"],
      ["beta", "codex"],
    ]);
  });

  it("gives only the first occurrence with a limit of 1, and filters by room and by agent", () => {
    const { messages } = searchMessages(db, { text: "pull/3126", limit: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ room: "alpha", agent: "claude", origin: "agent" });
    expect(searchMessages(db, { text: "pull/3126", room: "beta" }).messages.map((m) => m.room)).toEqual(["beta"]);
    expect(searchMessages(db, { text: "pull/3126", agent: "codex" }).messages.map((m) => m.agent)).toEqual(["codex"]);
    expect(searchMessages(db, { text: "pull/3126", room: "alpha", agent: "codex" }).total).toBe(0);
  });

  it("treats % and _ as text, not wildcards", () => {
    expect(searchMessages(db, { text: "100%" }).messages.map((m) => m.content)).toEqual(["Coverage went to 100% on the parser"]);
    expect(searchMessages(db, { text: "%" }).total).toBe(1);
    expect(searchMessages(db, { text: "progress_1" }).total).toBe(0);
  });

  it("prints room, agent, id, local date and the text around the match", () => {
    const [hit] = searchMessages(db, { text: "pull/3126", limit: 1 }).messages;
    expect(searchLine(hit, "pull/3126")).toMatch(new RegExp(`^alpha  claude  #${hit.id}  \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}  Opened https://github.com/acme/app/pull/3126`));
    const long = `${"x ".repeat(80)}needle${" y".repeat(80)}`;
    expect(snippet(long, "NEEDLE")).toMatch(/^….*needle.*…$/);
  });
});
