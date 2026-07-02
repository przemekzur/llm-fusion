import type { SessionRole } from "./types.js";

export interface LaunchProfile {
  id: string;
  label: string;
  provider: "claude" | "codex" | "shell";
  command: string;
  probe?: {
    command: string;
    expectedMarker: string;
    timeoutMs: number;
  };
}

export interface LaunchSlot {
  id: string;
  role: Extract<SessionRole, "coordinator" | "sidekick">;
  label: string;
  defaultProfileId: string;
}

export interface LaunchOverride {
  label?: string;
  command?: string;
  profileId?: string;
}

export interface BuildLaunchSessionsInput {
  cwd: string;
  overrides?: Record<string, LaunchOverride>;
}

export interface LaunchSessionInput {
  role: Extract<SessionRole, "coordinator" | "sidekick">;
  label: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

export const launchProfiles: LaunchProfile[] = [
  {
    id: "claude-opus-4-8-high",
    label: "Claude Opus 4.8 High",
    provider: "claude",
    command: "claude --model opus --effort high",
    probe: {
      command: 'claude --model opus --effort high --print "Reply with exactly: CLAUDE_OPUS_READY"',
      expectedMarker: "CLAUDE_OPUS_READY",
      timeoutMs: 90_000,
    },
  },
  {
    id: "claude-sonnet-5-high",
    label: "Claude Sonnet 5 High",
    provider: "claude",
    command: "claude --model sonnet --effort high",
    probe: {
      command: 'claude --model sonnet --effort high --print "Reply with exactly: CLAUDE_SONNET_READY"',
      expectedMarker: "CLAUDE_SONNET_READY",
      timeoutMs: 90_000,
    },
  },
  {
    id: "codex-configured-high",
    label: "Codex Configured High",
    provider: "codex",
    command: 'codex -c model_reasoning_effort="high" --no-alt-screen',
    probe: {
      command:
        'codex exec -c model_reasoning_effort="high" --sandbox read-only --skip-git-repo-check "Reply with exactly: CODEX_CONFIGURED_READY"',
      expectedMarker: "CODEX_CONFIGURED_READY",
      timeoutMs: 120_000,
    },
  },
  {
    id: "codex-5-3-high",
    label: "Codex 5.3 High",
    provider: "codex",
    command: 'codex --model codex-5.3 -c model_reasoning_effort="high" --no-alt-screen',
    probe: {
      command:
        'codex exec --model codex-5.3 -c model_reasoning_effort="high" --sandbox read-only --skip-git-repo-check "Reply with exactly: CODEX_5_3_READY"',
      expectedMarker: "CODEX_5_3_READY",
      timeoutMs: 120_000,
    },
  },
  {
    id: "claude-opus",
    label: "Claude Opus",
    provider: "claude",
    command: "claude --model opus",
  },
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    provider: "claude",
    command: "claude --model sonnet",
  },
  {
    id: "codex-default",
    label: "Codex Default",
    provider: "codex",
    command: "codex --no-alt-screen",
  },
  {
    id: "powershell",
    label: "PowerShell",
    provider: "shell",
    command: "powershell.exe",
  },
  {
    id: "bash",
    label: "Bash",
    provider: "shell",
    command: "bash",
  },
];

export const defaultLaunchSlots: LaunchSlot[] = [
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
];

export function getLaunchProfile(profileId: string): LaunchProfile {
  const profile = launchProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);
  return profile;
}

export function buildLaunchSessions(input: BuildLaunchSessionsInput): LaunchSessionInput[] {
  return defaultLaunchSlots.map((slot) => {
    const override = input.overrides?.[slot.id];
    const profile = getLaunchProfile(override?.profileId ?? slot.defaultProfileId);

    return {
      role: slot.role,
      label: override?.label?.trim() || profile.label,
      command: override?.command?.trim() || profile.command,
      cwd: input.cwd,
      cols: 120,
      rows: 32,
    };
  });
}
