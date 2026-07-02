import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFusionMessages, stripAnsi } from "./fusionParser.js";
import { runShellCommand, type CliProbeRunner } from "./profileReadiness.js";
import type { JsonStore } from "./jsonStore.js";
import type { SessionManager } from "./sessionManager.js";
import {
  type JobAttempt,
  type JobRecord,
  type JobRoute,
  type LedgerEvent,
} from "../shared/types.js";

// All long or user-authored text travels via files in the workspace, never
// through shell arguments: quoting survives cmd.exe and the CLIs read files
// reliably. The fixed -p prompts below must stay free of quotes and cmd
// metacharacters (% ^ & < > |).
const TASK_FILE = ".fusion-task.md";
const PLAN_FILE = ".fusion-plan.md";

const AGENT_PROMPT =
  "Read the file " +
  TASK_FILE +
  " in the current directory and complete the task it describes. Work autonomously without asking questions. When finished, print a final line starting with SUMMARY: followed by one sentence describing the outcome.";

const PLANNER_PROMPT =
  "Read the file " + PLAN_FILE + " in the current directory and follow its instructions exactly.";

const CLASSIFIER_PROMPT =
  "Read the file " + TASK_FILE + " in the current directory. Classify how it should be routed and print ONLY a single line of JSON with keys route and reason. route must be exactly one of: cheap (small, mechanical, or well specified single task), frontier (ambiguous, architectural, risky, or judgment heavy), fusion (large multi part work worth splitting into a plan plus delegated subtasks). Do not modify any files.";

const RouteDecisionSchema = z.object({
  route: z.enum(["cheap", "frontier", "fusion"]),
  reason: z.string().min(1),
});

export interface AutopilotModels {
  cheap: string;
  frontier: string;
}

export const defaultAutopilotModels: AutopilotModels = {
  cheap: "claude --model sonnet --effort high --permission-mode acceptEdits --allowedTools Bash",
  frontier: "claude --model opus --effort high --permission-mode acceptEdits --allowedTools Bash",
};

export interface AutopilotOptions {
  jobs: JsonStore<JobRecord[]>;
  appendLedger: (event: Omit<LedgerEvent, "ts" | "payload"> & { payload?: LedgerEvent["payload"] }) => void;
  runCommand?: CliProbeRunner;
  /** When provided, agent runs execute inside PTY sessions visible in the Terminals view. */
  sessionManager?: SessionManager;
  models?: AutopilotModels;
  timeouts?: { classifyMs?: number; agentMs?: number; verifyMs?: number };
}

export interface Autopilot {
  createJob(input: { goal: string; workspacePath: string; verifyCommand?: string; route?: JobRoute }): JobRecord;
  listJobs(): JobRecord[];
  getJob(id: string): JobRecord | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractSummary(output: string): string {
  const lines = output.split(/\r?\n/).reverse();
  const summaryLine = lines.find((line) => line.trim().startsWith("SUMMARY:"));
  if (summaryLine) return summaryLine.trim().slice("SUMMARY:".length).trim().slice(0, 500);
  return output.trim().slice(-400) || "(no output)";
}

function extractRouteDecision(output: string): z.infer<typeof RouteDecisionSchema> | undefined {
  // The classifier is told to print one JSON line; scan for the last parseable one.
  for (const line of output.split(/\r?\n/).reverse()) {
    const start = line.indexOf("{");
    const end = line.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = RouteDecisionSchema.safeParse(JSON.parse(line.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildPlannerInstructions(goal: string): string {
  return [
    "You are the planning coordinator in a local fusion harness.",
    "",
    "Mission goal:",
    goal,
    "",
    "Rules:",
    "- Do NOT implement anything yourself. Read whatever you need to plan well.",
    "- Split the goal into 1-5 delegable subtasks for implementation workers.",
    "- For each subtask, print exactly one line in this format (valid JSON after the marker):",
    '@@FUSION:{"type":"delegate","title":"Short subtask title","target":"sidekick","instructions":"Precise, self-contained instructions for the worker"}',
    "- Order the lines so earlier subtasks unblock later ones.",
    "- Print nothing else after the delegate lines.",
  ].join("\n");
}

export function createAutopilot(options: AutopilotOptions): Autopilot {
  const runCommand = options.runCommand ?? runShellCommand;
  const models = options.models ?? defaultAutopilotModels;
  const classifyMs = options.timeouts?.classifyMs ?? 120_000;
  const agentMs = options.timeouts?.agentMs ?? 900_000;
  const verifyMs = options.timeouts?.verifyMs ?? 600_000;

  function updateJob(id: string, mutator: (job: JobRecord) => JobRecord): JobRecord | undefined {
    let updated: JobRecord | undefined;
    options.jobs.update((items) =>
      items.map((job) => {
        if (job.id !== id) return job;
        updated = mutator({ ...job, updatedAt: nowIso() });
        return updated;
      }),
    );
    return updated;
  }

  function ledger(job: JobRecord, type: string, summary: string): void {
    options.appendLedger({ type, actor: "harness", taskId: job.id, summary: summary.slice(0, 400) });
  }

  interface AgentExecResult {
    output: string;
    ok: boolean;
    sessionId?: string;
  }

  async function execAgentCommand(
    job: JobRecord,
    command: string,
    label: string,
    timeoutMs: number,
  ): Promise<AgentExecResult> {
    const sessions = options.sessionManager;
    if (!sessions) {
      const result = await runCommand(command, { cwd: job.workspacePath, timeoutMs });
      return { output: `${result.stdout}\n${result.stderr}`, ok: result.exitCode === 0 && !result.timedOut };
    }

    // PTY-backed: the run streams live into the Terminals view.
    const session = sessions.createSession({
      role: "utility",
      label,
      command,
      cwd: job.workspacePath,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = sessions.getSession(session.id);
      if (!record || record.status !== "active") {
        return {
          output: stripAnsi(sessions.readBuffer(session.id)),
          ok: record?.status === "exited",
          sessionId: session.id,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    try {
      sessions.stop(session.id);
    } catch {
      // already gone
    }
    return { output: stripAnsi(sessions.readBuffer(session.id)), ok: false, sessionId: session.id };
  }

  async function runAgent(job: JobRecord, route: JobRoute, taskText: string, label: string): Promise<JobAttempt> {
    const attempt: JobAttempt = {
      route,
      label,
      status: "running",
      summary: "",
      startedAt: nowIso(),
    };
    updateJob(job.id, (current) => ({ ...current, status: "running", attempts: [...current.attempts, attempt] }));
    ledger(job, "job.attempt.started", `${label} started.`);

    writeFileSync(join(job.workspacePath, TASK_FILE), taskText, "utf8");
    const command = `${route === "cheap" ? models.cheap : models.frontier} -p "${AGENT_PROMPT}"`;
    const result = await execAgentCommand(job, command, label, agentMs);

    attempt.summary = extractSummary(result.output);
    attempt.sessionId = result.sessionId;
    attempt.endedAt = nowIso();
    attempt.status = result.ok ? "succeeded" : "failed";
    updateJob(job.id, (current) => ({
      ...current,
      attempts: current.attempts.map((item) =>
        item.label === label && item.startedAt === attempt.startedAt ? { ...attempt } : item,
      ),
    }));
    ledger(job, "job.attempt.finished", `${label} ${attempt.status}: ${attempt.summary.slice(0, 160)}`);
    return attempt;
  }

  async function verify(job: JobRecord): Promise<{ ok: boolean; evidence: string } | undefined> {
    if (!job.verifyCommand) return undefined;
    updateJob(job.id, (current) => ({ ...current, status: "verifying" }));
    const result = await runCommand(job.verifyCommand, { cwd: job.workspacePath, timeoutMs: verifyMs });
    const ok = result.exitCode === 0 && !result.timedOut;
    const evidence = ok ? "verify command exit 0" : `${result.stdout}\n${result.stderr}`.trim().slice(-300);
    ledger(job, ok ? "job.verified" : "job.verify_failed", evidence);
    return { ok, evidence };
  }

  function markLastAttemptVerifyFailed(jobId: string): void {
    updateJob(jobId, (current) => ({
      ...current,
      attempts: current.attempts.map((item, index) =>
        index === current.attempts.length - 1 && item.status === "succeeded"
          ? { ...item, status: "verify_failed" }
          : item,
      ),
    }));
  }

  function finish(jobId: string, status: "succeeded" | "failed", summary: string): void {
    const job = updateJob(jobId, (current) => ({ ...current, status, resultSummary: summary.slice(0, 600) }));
    if (job) ledger(job, `job.${status}`, summary);
  }

  async function runFusion(job: JobRecord): Promise<JobAttempt> {
    const attempt: JobAttempt = {
      route: "fusion",
      label: "fusion: plan + delegate + review",
      status: "running",
      summary: "",
      startedAt: nowIso(),
    };
    updateJob(job.id, (current) => ({ ...current, status: "running", attempts: [...current.attempts, attempt] }));
    ledger(job, "job.attempt.started", "fusion planning started.");

    writeFileSync(join(job.workspacePath, PLAN_FILE), buildPlannerInstructions(job.goal), "utf8");
    const planResult = await execAgentCommand(
      job,
      `${models.frontier} -p "${PLANNER_PROMPT}"`,
      "fusion planner",
      agentMs,
    );
    const delegates = parseFusionMessages(planResult.output);

    if (!delegates.length) {
      attempt.status = "failed";
      attempt.summary = "Planner produced no delegate lines.";
      attempt.endedAt = nowIso();
      updateJob(job.id, (current) => ({
        ...current,
        attempts: current.attempts.map((item, index) =>
          index === current.attempts.length - 1 ? { ...attempt } : item,
        ),
      }));
      ledger(job, "job.attempt.finished", attempt.summary);
      return attempt;
    }

    ledger(job, "job.plan", `Planner produced ${delegates.length} subtasks: ${delegates.map((d) => d.title).join(" | ")}`);

    const reports: string[] = [];
    let allWorkersSucceeded = true;
    for (const [index, delegate] of delegates.entries()) {
      const workerTask = [
        `Subtask ${index + 1} of ${delegates.length} for the mission: ${job.goal}`,
        "",
        `Title: ${delegate.title}`,
        "Instructions:",
        delegate.instructions,
        "",
        "Do exactly this subtask. Do not broaden scope.",
      ].join("\n");
      const worker = await runAgent(job, "cheap", workerTask, `fusion worker ${index + 1}/${delegates.length}: ${delegate.title}`);
      reports.push(`${delegate.title}: ${worker.status} - ${worker.summary}`);
      if (worker.status !== "succeeded") {
        allWorkersSucceeded = false;
        break;
      }
    }

    // Final review pass: the frontier model checks the combined work against
    // the goal and is allowed to fix problems it finds.
    if (allWorkersSucceeded) {
      const reviewTask = [
        `Mission goal: ${job.goal}`,
        "",
        "Implementation workers completed these subtasks:",
        ...reports.map((report) => `- ${report}`),
        "",
        "Review the work in this workspace against the mission goal. Check correctness, completeness, and consistency. Fix any problems you find yourself.",
      ].join("\n");
      const review = await runAgent(job, "frontier", reviewTask, "fusion review");
      reports.push(`review: ${review.status} - ${review.summary}`);
      if (review.status !== "succeeded") allWorkersSucceeded = false;
    }

    attempt.summary = reports.join(" | ").slice(0, 500);
    attempt.endedAt = nowIso();
    attempt.status = allWorkersSucceeded ? "succeeded" : "failed";
    updateJob(job.id, (current) => ({
      ...current,
      attempts: current.attempts.map((item) => (item.label === attempt.label ? { ...item, ...attempt } : item)),
    }));
    ledger(job, "job.attempt.finished", `fusion ${attempt.status}: ${attempt.summary.slice(0, 160)}`);
    return attempt;
  }

  async function runJob(jobId: string): Promise<void> {
    let job = options.jobs.read().find((item) => item.id === jobId);
    if (!job) return;

    // Classify (unless the operator forced a route).
    let decision: { route: JobRoute; reason: string };
    if (job.route) {
      decision = { route: job.route, reason: job.routeReason ?? "Operator override." };
    } else {
      writeFileSync(join(job.workspacePath, TASK_FILE), job.goal, "utf8");
      const classifierResult = await runCommand(`${models.cheap} -p "${CLASSIFIER_PROMPT}"`, {
        cwd: job.workspacePath,
        timeoutMs: classifyMs,
      });
      decision = extractRouteDecision(`${classifierResult.stdout}\n${classifierResult.stderr}`) ?? {
        route: "cheap" as const,
        reason: "Classifier output was unusable; defaulting to the cheap route.",
      };
    }
    job = updateJob(jobId, (current) => ({ ...current, route: decision.route, routeReason: decision.reason })) ?? job;
    ledger(job, "job.classified", `Route ${decision.route}: ${decision.reason}`);

    // A failed attempt leaves its changes behind; give the next route a clean
    // slate, but only when the workspace is a git repo that was clean at job
    // start (never revert pre-existing user changes).
    const gitStatus = await runCommand("git status --porcelain", { cwd: job.workspacePath, timeoutMs: 30_000 });
    const resettable = gitStatus.exitCode === 0 && !gitStatus.stdout.trim();

    async function resetWorkspace(): Promise<void> {
      if (!resettable) {
        ledger(job!, "job.workspace_kept", "Workspace not reset (not a clean git repo at job start).");
        return;
      }
      await runCommand("git checkout -- .", { cwd: job!.workspacePath, timeoutMs: 60_000 });
      await runCommand("git clean -fd", { cwd: job!.workspacePath, timeoutMs: 60_000 });
      ledger(job!, "job.workspace_reset", "Reverted the failed attempt before escalating.");
    }

    // Escalation ladder.
    const ladder: JobRoute[] = decision.route === "frontier" ? ["frontier"] : [decision.route, "frontier"];

    for (const [step, route] of ladder.entries()) {
      const label =
        route === "fusion"
          ? "fusion: plan + delegate + review"
          : `${route === "cheap" ? "cheap solo" : "frontier solo"}${step > 0 ? " (escalated)" : ""}`;

      const attempt = route === "fusion" ? await runFusion(job) : await runAgent(job, route, job.goal, label);

      if (attempt.status !== "succeeded") {
        if (step === ladder.length - 1) {
          finish(jobId, "failed", `All routes exhausted. Last attempt: ${attempt.summary}`);
          return;
        }
        ledger(job, "job.escalated", `${label} failed; escalating.`);
        updateJob(jobId, (current) => ({ ...current, status: "escalating" }));
        await resetWorkspace();
        continue;
      }

      const verification = await verify(job);
      if (!verification || verification.ok) {
        const note = verification ? "verified" : "unverified (no verify command)";
        finish(jobId, "succeeded", `${attempt.summary} [${note}]`);
        return;
      }

      markLastAttemptVerifyFailed(jobId);
      if (step === ladder.length - 1) {
        finish(jobId, "failed", `Verification failed after final route: ${verification.evidence}`);
        return;
      }
      ledger(job, "job.escalated", `Verification failed on ${label}; escalating.`);
      updateJob(jobId, (current) => ({ ...current, status: "escalating" }));
      await resetWorkspace();
    }
  }

  return {
    createJob(input) {
      const createdAt = nowIso();
      const job: JobRecord = {
        id: `job-${randomUUID()}`,
        goal: input.goal,
        workspacePath: input.workspacePath,
        verifyCommand: input.verifyCommand,
        status: "classifying",
        route: input.route,
        routeReason: input.route ? "Operator override." : undefined,
        attempts: [],
        resultSummary: "",
        createdAt,
        updatedAt: createdAt,
      };
      options.jobs.update((items) => [...items, job]);
      ledger(job, "job.created", `Goal: ${job.goal.slice(0, 200)}`);

      void runJob(job.id).catch((error) => {
        finish(job.id, "failed", `Autopilot error: ${error instanceof Error ? error.message : String(error)}`);
      });

      return job;
    },

    listJobs() {
      return options.jobs.read();
    },

    getJob(id) {
      return options.jobs.read().find((job) => job.id === id);
    },
  };
}
