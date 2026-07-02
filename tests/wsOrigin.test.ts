import { describe, expect, it } from "vitest";
import { isAllowedWsOrigin } from "../src/server/index.js";

describe("websocket origin guard", () => {
  it("allows non-browser clients that send no Origin", () => {
    expect(isAllowedWsOrigin(undefined, "127.0.0.1:4174")).toBe(true);
  });

  it("allows same-origin loopback browsers", () => {
    expect(isAllowedWsOrigin("http://127.0.0.1:4174", "127.0.0.1:4174")).toBe(true);
    expect(isAllowedWsOrigin("http://localhost:4174", "localhost:4174")).toBe(true);
  });

  it("rejects cross-site origins", () => {
    expect(isAllowedWsOrigin("https://evil.example.com", "127.0.0.1:4174")).toBe(false);
    expect(isAllowedWsOrigin("http://127.0.0.1.evil.com", "127.0.0.1:4174")).toBe(false);
  });

  it("rejects a loopback origin whose port differs from the target host", () => {
    expect(isAllowedWsOrigin("http://127.0.0.1:9999", "127.0.0.1:4174")).toBe(false);
  });

  it("rejects a malformed origin", () => {
    expect(isAllowedWsOrigin("not-a-url", "127.0.0.1:4174")).toBe(false);
  });
});
