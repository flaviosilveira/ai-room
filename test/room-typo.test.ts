import { describe, expect, it } from "vitest";
import { nearRoom, roomNameSlip } from "../src/open.js";

describe("catching a mistyped room name", () => {
  it("strips stray punctuation at either end", () => {
    expect(roomNameSlip("alchemy-flakies-from-posting,")).toBe("alchemy-flakies-from-posting");
    expect(roomNameSlip(" 'refund-review'. ")).toBe("refund-review");
    expect(roomNameSlip("refund-review")).toBeNull();
  });

  it("finds an existing room that differs only in case or separators", () => {
    const rooms = ["refund-review", "alchemy-flakies-from-posting"];
    expect(nearRoom("Refund_Review", rooms)).toBe("refund-review");
    expect(nearRoom("alchemyflakiesfromposting", rooms)).toBe("alchemy-flakies-from-posting");
    expect(nearRoom("refund-review", rooms)).toBeNull();
    expect(nearRoom("refund-reviews", rooms)).toBeNull();
  });
});
