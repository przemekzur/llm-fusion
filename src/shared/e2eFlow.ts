export interface HarnessFlowProbe {
  missionTitle: string;
  missionPrompt: string;
  coordinatorMarker: string;
  sidekickMarkers: string[];
  sidekickTasks: Array<{
    title: string;
    instructions: string;
    marker: string;
  }>;
}

export type MarkerStatus = "pending" | "pass";

export function buildHarnessFlowProbe(input: { workspacePath: string }): HarnessFlowProbe {
  const coordinatorMarker = "FUSION_COORDINATOR_READY";
  const sidekickMarkers = ["FUSION_SIDEKICK_1_READY", "FUSION_SIDEKICK_2_READY"];

  return {
    missionTitle: "LLM Fusion E2E Probe",
    missionPrompt: [
      "This is an end-to-end harness probe.",
      `Workspace: ${input.workspacePath}`,
      `Reply with exactly ${coordinatorMarker} and no extra prose.`,
    ].join("\n"),
    coordinatorMarker,
    sidekickMarkers,
    sidekickTasks: sidekickMarkers.map((marker, index) => ({
      title: `Sidekick ${index + 1} marker probe`,
      instructions: [
        `This is an end-to-end sidekick ${index + 1} probe.`,
        `Workspace: ${input.workspacePath}`,
        `Reply with exactly ${marker} and no extra prose.`,
      ].join("\n"),
      marker,
    })),
  };
}

export function markerStatus(buffer: string, marker: string): MarkerStatus {
  return buffer.includes(marker) ? "pass" : "pending";
}
