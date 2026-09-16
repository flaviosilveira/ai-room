import { describe, expect, it } from "vitest";
import { MIN_NODE_API, unsupportedRuntimeMessage } from "../src/preflight.js";

describe("runtime preflight", () => {
  it("rejects the Node-API 9 runtimes that segfault on the sqlite binding", () => {
    const message = unsupportedRuntimeMessage("9", "v22.12.0", "/node");
    expect(message).toContain("unsupported Node runtime");
    expect(message).toContain("v22.12.0");
    expect(message).toContain(`need ${MIN_NODE_API}`);
  });

  it("rejects a runtime that reports no Node-API version", () => {
    expect(unsupportedRuntimeMessage(undefined)).toContain("unknown");
  });

  it("accepts the minimum supported Node-API version and above", () => {
    expect(unsupportedRuntimeMessage(String(MIN_NODE_API))).toBeNull();
    expect(unsupportedRuntimeMessage(String(MIN_NODE_API + 1))).toBeNull();
  });

  it("accepts the runtime the test suite itself runs on", () => {
    expect(unsupportedRuntimeMessage(process.versions.napi)).toBeNull();
  });
});
