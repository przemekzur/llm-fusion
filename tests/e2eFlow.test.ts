import { describe, expect, it } from "vitest";
import { buildHarnessFlowProbe, markerStatus } from "../src/shared/e2eFlow.js";

describe("harness E2E flow", () => {
  it("builds measurable coordinator and sidekick marker prompts", () => {
    const flow = buildHarnessFlowProbe({ workspacePath: "C:\\repo" });

    expect(flow.missionTitle).toBe("LLM Fusion E2E Probe");
    expect(flow.coordinatorMarker).toBe("FUSION_COORDINATOR_READY");
    expect(flow.sidekickMarkers).toEqual(["FUSION_SIDEKICK_1_READY", "FUSION_SIDEKICK_2_READY"]);
    expect(flow.missionPrompt).toContain("FUSION_COORDINATOR_READY");
    expect(flow.sidekickTasks[0]?.instructions).toContain("FUSION_SIDEKICK_1_READY");
    expect(flow.sidekickTasks[1]?.instructions).toContain("FUSION_SIDEKICK_2_READY");
    expect(flow.sidekickTasks[0]?.instructions).toContain("C:\\repo");
  });

  it("detects marker pass/fail status from terminal buffers", () => {
    expect(markerStatus("prefix FUSION_COORDINATOR_READY suffix", "FUSION_COORDINATOR_READY")).toBe("pass");
    expect(markerStatus("waiting", "FUSION_COORDINATOR_READY")).toBe("pending");
  });
});
