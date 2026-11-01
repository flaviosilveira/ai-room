import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { openQuestions, roomJoin, roomSend } from "../src/store.js";
import { tmuxConfig } from "../src/session.js";

describe("questions for the human", () => {
  it("keeps a [FOR YOU] open until the human answers it", () => {
    const db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human" });
    roomJoin(db, { room: "r", agent: "claude", role: "lead" });
    const ask = (message: string) => roomSend(db, { room: "r", agent: "claude", message, to: ["human"] });
    const answer = (message: string) => roomSend(db, { room: "r", agent: "human", message, origin: "human" });

    ask("[FOR YOU #1] Deploy now? (a) yes (b) no");
    expect(openQuestions(db, "r").map((q) => q.n)).toEqual([1]);
    answer("/allow 3");
    expect(openQuestions(db, "r")).toHaveLength(1);
    answer("yes, go");
    expect(openQuestions(db, "r")).toEqual([]);

    ask("[FOR YOU #2] Which region?");
    ask("[FOR YOU #3] Keep the old table?");
    answer("we'll see");
    expect(openQuestions(db, "r").map((q) => q.n)).toEqual([2, 3]);
    answer("#3 b");
    expect(openQuestions(db, "r")).toMatchObject([{ n: 2, agent: "claude", text: "[FOR YOU #2] Which region?" }]);
    answer("us-east-1");
    expect(openQuestions(db, "r")).toEqual([]);
    db.close();
  });

  it("binds prefix a to the questions modal, leaving C-a alone", () => {
    const config = tmuxConfig("ai-room", null, "x");
    expect(config).toContain(`bind-key a run-shell -b "ai-room _ask-open '#{session_name}' '#{client_name}'"`);
    expect(config).not.toMatch(/bind-key C-a /);
  });
});
