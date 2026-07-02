import { exec } from "node:child_process";
import type { LaunchProfile } from "../shared/launchProfiles.js";

export type ProfileReadinessStatus = "ready" | "blocked" | "untested";

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface ProfileReadinessResult {
  profileId: string;
  label: string;
  provider: LaunchProfile["provider"];
  status: ProfileReadinessStatus;
  command: string;
  probeCommand?: string;
  expectedMarker?: string;
  exitCode?: number;
  durationMs?: number;
  evidence: string;
}

export type CliProbeRunner = (command: string, options: { cwd: string; timeoutMs: number }) => Promise<CommandRunResult>;

export interface RunProfileReadinessInput {
  cwd: string;
  profile: LaunchProfile;
  runCommand?: CliProbeRunner;
}

export async function runProfileReadiness(input: RunProfileReadinessInput): Promise<ProfileReadinessResult> {
  const { profile } = input;

  if (!profile.probe) {
    return {
      profileId: profile.id,
      label: profile.label,
      provider: profile.provider,
      status: "untested",
      command: profile.command,
      evidence: "No non-interactive readiness probe is configured for this profile.",
    };
  }

  const runCommand = input.runCommand ?? runShellCommand;
  const result = await runCommand(profile.probe.command, {
    cwd: input.cwd,
    timeoutMs: profile.probe.timeoutMs,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const hasMarker = output.includes(profile.probe.expectedMarker);
  const status: ProfileReadinessStatus = result.exitCode === 0 && hasMarker && !result.timedOut ? "ready" : "blocked";

  return {
    profileId: profile.id,
    label: profile.label,
    provider: profile.provider,
    status,
    command: profile.command,
    probeCommand: profile.probe.command,
    expectedMarker: profile.probe.expectedMarker,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    evidence: summarizeEvidence(output || "(no output)"),
  };
}

export function runShellCommand(command: string, options: { cwd: string; timeoutMs: number }): Promise<CommandRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 4,
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut: Boolean(error?.killed),
        });
      },
    );
    child.stdin?.end();
  });
}

function summarizeEvidence(output: string): string {
  return output.length > 2000 ? output.slice(-2000) : output;
}
