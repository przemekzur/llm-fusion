import { describe, expect, it } from "vitest";
import { buildLaunchSessions, defaultLaunchSlots, launchProfiles } from "../src/shared/launchProfiles.js";

describe("launch profiles", () => {
  it("defaults to one opus coordinator, one sonnet sidekick, and one validated codex sidekick", () => {
    expect(defaultLaunchSlots).toEqual([
      {
        id: "coordinator",
        role: "coordinator",
        label: "Claude Opus 4.8 High",
        defaultProfileId: "claude-opus-4-8-high",
      },
      {
        id: "sidekick-a",
        role: "sidekick",
        label: "Claude Sonnet 5 High",
        defaultProfileId: "claude-sonnet-5-high",
      },
      {
        id: "sidekick-b",
        role: "sidekick",
        label: "Codex Configured High",
        defaultProfileId: "codex-configured-high",
      },
    ]);
  });

  it("builds default local LLM CLI sessions instead of shell sessions", () => {
    const sessions = buildLaunchSessions({ cwd: "C:\\repo" });

    expect(sessions).toEqual([
      {
        role: "coordinator",
        label: "Claude Opus 4.8 High",
        command: "claude --model opus --effort high",
        cwd: "C:\\repo",
        cols: 120,
        rows: 32,
      },
      {
        role: "sidekick",
        label: "Claude Sonnet 5 High",
        command: "claude --model sonnet --effort high",
        cwd: "C:\\repo",
        cols: 120,
        rows: 32,
      },
      {
        role: "sidekick",
        label: "Codex Configured High",
        command: 'codex -c model_reasoning_effort="high" --no-alt-screen',
        cwd: "C:\\repo",
        cols: 120,
        rows: 32,
      },
    ]);
  });

  it("supports per-slot command overrides from the launcher UI", () => {
    const sessions = buildLaunchSessions({
      cwd: "C:\\repo",
      overrides: {
        "sidekick-b": {
          label: "Codex custom",
          command: "codex --model gpt-5.3-codex",
        },
      },
    });

    expect(sessions[2]).toMatchObject({
      role: "sidekick",
      label: "Codex custom",
      command: "codex --model gpt-5.3-codex",
    });
  });

  it("exposes selectable LLM profile commands for every default slot", () => {
    const profileIds = new Set(launchProfiles.map((profile) => profile.id));

    for (const slot of defaultLaunchSlots) {
      expect(profileIds.has(slot.defaultProfileId)).toBe(true);
    }
  });
});
