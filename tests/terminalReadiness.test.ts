import { describe, expect, it } from "vitest";
import { terminalReadinessStatus } from "../src/shared/terminalReadiness.js";

describe("terminal readiness", () => {
  it("waits for Codex to render its interactive prompt before sending tasks", () => {
    expect(
      terminalReadinessStatus({
        provider: "codex",
        buffer: "OpenAI Codex (v0.142.5)\r\nStarting MCP servers...",
      }),
    ).toEqual({ status: "pending", evidence: "Waiting for Codex prompt." });

    expect(
      terminalReadinessStatus({
        provider: "codex",
        buffer: "OpenAI Codex (v0.142.5)\r\nmodel: gpt-5.5 high\r\nWrite tests for @filename",
      }),
    ).toEqual({ status: "ready", evidence: "Codex prompt is visible." });

    expect(
      terminalReadinessStatus({
        provider: "codex",
        buffer: "OpenAI Codex (v0.142.5)\r\nmodel: gpt-5.5 high\r\nFind and fix a bug in @filename",
      }),
    ).toEqual({ status: "ready", evidence: "Codex prompt is visible." });

    expect(
      terminalReadinessStatus({
        provider: "codex",
        buffer: "OpenAI Codex (v0.142.5)\r\nmodel: gpt-5.5 high\r\nImplement {feature}",
      }),
    ).toEqual({ status: "ready", evidence: "Codex prompt is visible." });
  });

  it("detects Claude interactive readiness from its welcome screen", () => {
    expect(
      terminalReadinessStatus({
        provider: "claude",
        buffer: "Claude Code\r\nWelcome back",
      }),
    ).toEqual({ status: "ready", evidence: "Claude prompt is visible." });
  });
});
