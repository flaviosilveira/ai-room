import { describe, expect, it } from "vitest";
import { nearRoom, roomNameSlip } from "../src/open.js";

describe("catching a mistyped room name", () => {
  it("strips stray punctuation at either end", () => {
    expect(roomNameSlip("billing-flaky-tests,")).toBe("billing-flaky-tests");
    expect(roomNameSlip(" 'refund-review'. ")).toBe("refund-review");
    expect(roomNameSlip("refund-review")).toBeNull();
  });

  it("finds an existing room that differs only in case or separators", () => {
    const rooms = ["refund-review", "billing-flaky-tests"];
    expect(nearRoom("Refund_Review", rooms)).toBe("refund-review");
    expect(nearRoom("billingflakytests", rooms)).toBe("billing-flaky-tests");
    expect(nearRoom("refund-review", rooms)).toBeNull();
    expect(nearRoom("refund-reviews", rooms)).toBeNull();
  });
});
