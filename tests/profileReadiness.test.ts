import { describe, expect, it } from "vitest";
import { runProfileReadiness } from "../src/server/profileReadiness.js";
import { getLaunchProfile } from "../src/shared/launchProfiles.js";

describe("profile readiness", () => {
  it("marks a profile ready when its probe command exits cleanly and emits the expected marker", async () => {
    const result = await runProfileReadiness({
      cwd: "C:\\repo",
      profile: getLaunchProfile("claude-opus-4-8-high"),
      runCommand: async () => ({
        exitCode: 0,
        stdout: "CLAUDE_OPUS_READY\n",
        stderr: "",
        durationMs: 12,
      }),
    });

    expect(result).toMatchObject({
      profileId: "claude-opus-4-8-high",
      status: "ready",
      expectedMarker: "CLAUDE_OPUS_READY",
      exitCode: 0,
    });
  });

  it("marks unsupported model responses as blocked with stderr evidence", async () => {
    const result = await runProfileReadiness({
      cwd: "C:\\repo",
      profile: getLaunchProfile("codex-5-3-high"),
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "The 'codex-5.3' model is not supported when using Codex with a ChatGPT account.",
        durationMs: 18,
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.evidence).toContain("codex-5.3");
    expect(result.evidence).toContain("not supported");
  });

  it("marks profiles without probes as untested", async () => {
    const result = await runProfileReadiness({
      cwd: "C:\\repo",
      profile: getLaunchProfile("powershell"),
      runCommand: async () => {
        throw new Error("should not run");
      },
    });

    expect(result).toMatchObject({
      profileId: "powershell",
      status: "untested",
    });
  });
});
