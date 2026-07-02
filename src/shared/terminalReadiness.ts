import type { LaunchProfile } from "./launchProfiles.js";

export type TerminalReadinessProvider = LaunchProfile["provider"];
export type TerminalReadinessState = "pending" | "ready" | "blocked";

export interface TerminalReadinessInput {
  provider: TerminalReadinessProvider;
  buffer: string;
}

export interface TerminalReadinessResult {
  status: TerminalReadinessState;
  evidence: string;
}

const CODEX_BLOCKERS = [
  "not supported",
  "not authenticated",
  "please login",
  "login required",
  "authentication required",
];

export function terminalReadinessStatus(input: TerminalReadinessInput): TerminalReadinessResult {
  const normalized = input.buffer.toLowerCase();

  if (input.provider === "codex") {
    if (CODEX_BLOCKERS.some((marker) => normalized.includes(marker))) {
      return { status: "blocked", evidence: "Codex reported an authentication or model availability blocker." };
    }

    if (normalized.includes("openai codex") && normalized.includes("gpt-")) {
      return { status: "ready", evidence: "Codex prompt is visible." };
    }

    return { status: "pending", evidence: "Waiting for Codex prompt." };
  }

  if (input.provider === "claude") {
    if (normalized.includes("claude code") || normalized.includes("welcome back")) {
      return { status: "ready", evidence: "Claude prompt is visible." };
    }

    return { status: "pending", evidence: "Waiting for Claude prompt." };
  }

  return { status: "ready", evidence: "Shell profile does not require model prompt readiness." };
}
