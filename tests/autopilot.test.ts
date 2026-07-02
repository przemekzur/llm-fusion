import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutopilot } from "../src/server/autopilot.js";
import { createJsonStore } from "../src/server/jsonStore.js";
import { z } from "zod";
import { JobSchema, type JobRecord, type LedgerEvent } from "../src/shared/types.js";
import type { CommandRunResult } from "../src/server/profileReadiness.js";

let dir = "";
let events: Array<Partial<LedgerEvent>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-autopilot-"));
  events = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ok(stdout: string): CommandRunResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 10 };
}

function fail(stdout: string): CommandRunResult {
  return { exitCode: 1, stdout, stderr: "", durationMs: 10 };
}

function makeAutopilot(
  script: Array<(command: string, cwd: string) => CommandRunResult>,
  options: { gitDirty?: boolean } = {},
) {
  const jobs = createJsonStore<JobRecord[]>(join(dir, "jobs.json"), [], z.array(JobSchema));
  const calls: string[] = [];
  const gitCalls: string[] = [];
  let step = 0;

  const autopilot = createAutopilot({
    jobs,
    appendLedger: (event) => events.push(event),
    runCommand: async (command, options_) => {
      if (command.startsWith("git ")) {
        gitCalls.push(command);
        return ok(command.includes("status") && options.gitDirty ? " M dirty.txt" : "");
      }
      calls.push(command);
      const handler = script[Math.min(step, script.length - 1)];
      step += 1;
      return handler(command, options_.cwd);
    },
  });

  return { autopilot, jobs, calls, gitCalls };
}

async function waitForJob(jobs: ReturnType<typeof createJsonStore<JobRecord[]>>, predicate: (job: JobRecord) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = jobs.read()[0];
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out. Job: ${JSON.stringify(jobs.read()[0], null, 2)}`);
}

describe("autopilot", () => {
  it("classifies cheap, runs the cheap agent, verifies, and succeeds", async () => {
    const { autopilot, jobs, calls } = makeAutopilot([
      () => ok('{"route":"cheap","reason":"small mechanical task"}'),
      () => ok("did the thing\nSUMMARY: renamed the helper everywhere."),
      () => ok("tests pass"),
    ]);

    autopilot.createJob({ goal: "Rename the helper", workspacePath: dir, verifyCommand: "npm test" });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.route).toBe("cheap");
    expect(job.attempts).toHaveLength(1);
    expect(job.attempts[0]?.status).toBe("succeeded");
    expect(job.resultSummary).toContain("renamed the helper");
    expect(job.resultSummary).toContain("[verified]");
    expect(calls[0]).toContain("--model sonnet");
    expect(calls[1]).toContain("--model sonnet");
    expect(readFileSync(join(dir, ".fusion-task.md"), "utf8")).toContain("Rename the helper");
  });

  it("escalates to frontier when cheap verification fails, resetting the workspace", async () => {
    const { autopilot, jobs, calls, gitCalls } = makeAutopilot([
      () => ok('{"route":"cheap","reason":"looks simple"}'),
      () => ok("SUMMARY: attempted fix."),
      () => fail("2 tests failing"),
      () => ok("SUMMARY: fixed properly this time."),
      () => ok("all green"),
    ]);

    autopilot.createJob({ goal: "Fix the failing tests", workspacePath: dir, verifyCommand: "npm test" });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.attempts).toHaveLength(2);
    expect(job.attempts[0]?.status).toBe("verify_failed");
    expect(job.attempts[1]?.status).toBe("succeeded");
    expect(job.attempts[1]?.label).toContain("escalated");
    expect(calls[3]).toContain("--model opus");
    expect(events.some((event) => event.type === "job.escalated")).toBe(true);
    expect(gitCalls).toContain("git checkout -- .");
    expect(gitCalls).toContain("git clean -fd");
    expect(events.some((event) => event.type === "job.workspace_reset")).toBe(true);
  });

  it("never resets a workspace that was dirty at job start", async () => {
    const { autopilot, jobs, gitCalls } = makeAutopilot(
      [
        () => ok('{"route":"cheap","reason":"simple"}'),
        () => ok("SUMMARY: attempt one."),
        () => fail("failing"),
        () => ok("SUMMARY: attempt two."),
        () => ok("green"),
      ],
      { gitDirty: true },
    );

    autopilot.createJob({ goal: "Fix it", workspacePath: dir, verifyCommand: "npm test" });
    await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(gitCalls.some((command) => command.includes("checkout") || command.includes("clean"))).toBe(false);
    expect(events.some((event) => event.type === "job.workspace_kept")).toBe(true);
  });

  it("fails the job when the frontier attempt also fails verification", async () => {
    const { autopilot, jobs } = makeAutopilot([
      () => ok('{"route":"cheap","reason":"simple"}'),
      () => ok("SUMMARY: try one."),
      () => fail("still failing"),
      () => ok("SUMMARY: try two."),
      () => fail("still failing"),
    ]);

    autopilot.createJob({ goal: "Fix it", workspacePath: dir, verifyCommand: "npm test" });
    const job = await waitForJob(jobs, (item) => item.status === "failed");

    expect(job.attempts).toHaveLength(2);
    expect(job.resultSummary).toContain("Verification failed");
  });

  it("routes frontier directly without escalation ladder", async () => {
    const { autopilot, jobs, calls } = makeAutopilot([
      () => ok('{"route":"frontier","reason":"ambiguous architecture decision"}'),
      () => ok("SUMMARY: designed and implemented."),
    ]);

    autopilot.createJob({ goal: "Restructure the module boundaries", workspacePath: dir });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.route).toBe("frontier");
    expect(job.attempts).toHaveLength(1);
    expect(job.resultSummary).toContain("[unverified");
    expect(calls[1]).toContain("--model opus");
  });

  it("fusion route plans with frontier, delegates to cheap workers, then reviews", async () => {
    const { autopilot, jobs, calls } = makeAutopilot([
      () => ok('{"route":"fusion","reason":"large multi-part sweep"}'),
      () =>
        ok(
          [
            "Plan follows.",
            '@@FUSION:{"type":"delegate","title":"Add helper","instructions":"Add renderUpper to render.js"}',
            '@@FUSION:{"type":"delegate","title":"Sweep reports","instructions":"Update all report modules"}',
          ].join("\n"),
        ),
      () => ok("SUMMARY: helper added."),
      () => ok("SUMMARY: sweep complete."),
      () => ok("SUMMARY: reviewed, consistent, no fixes needed."),
      () => ok("all tests pass"),
    ]);

    autopilot.createJob({ goal: "Extract helper across the fleet", workspacePath: dir, verifyCommand: "npm test" });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.route).toBe("fusion");
    const workerAttempts = job.attempts.filter((attempt) => attempt.label.startsWith("fusion worker"));
    expect(workerAttempts).toHaveLength(2);
    expect(workerAttempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    const review = job.attempts.find((attempt) => attempt.label === "fusion review");
    expect(review?.status).toBe("succeeded");
    expect(review?.route).toBe("frontier");
    expect(calls[1]).toContain("--model opus");
    expect(calls[2]).toContain("--model sonnet");
    expect(calls[4]).toContain("--model opus");
    expect(events.some((event) => event.type === "job.plan" && event.summary?.includes("2 subtasks"))).toBe(true);
  });

  it("runs agents in PTY sessions when a session manager is provided", async () => {
    const jobs = createJsonStore<JobRecord[]>(join(dir, "jobs.json"), [], z.array(JobSchema));
    const created: Array<{ label: string; command: string }> = [];
    const fakeSessions = {
      createSession(input: { label: string; command: string }) {
        created.push({ label: input.label, command: input.command });
        return { id: `session-${created.length}`, status: "active" };
      },
      getSession(id: string) {
        return { id, status: "exited" };
      },
      readBuffer() {
        return "working...\nSUMMARY: done via pty.";
      },
      stop() {},
    };

    const autopilot = createAutopilot({
      jobs,
      appendLedger: (event) => events.push(event),
      sessionManager: fakeSessions as never,
      runCommand: async (command) => {
        if (command.startsWith("git ")) return ok("");
        return ok('{"route":"cheap","reason":"simple"}');
      },
    });

    autopilot.createJob({ goal: "Do a small thing", workspacePath: dir });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.attempts[0]?.sessionId).toBe("session-1");
    expect(job.attempts[0]?.summary).toBe("done via pty.");
    expect(created[0]?.command).toContain("--model sonnet");
    expect(created[0]?.label).toContain("cheap solo");
  });

  it("defaults to cheap when the classifier output is garbage", async () => {
    const { autopilot, jobs } = makeAutopilot([
      () => ok("I think this task is probably not too hard?"),
      () => ok("SUMMARY: done."),
    ]);

    autopilot.createJob({ goal: "Do something", workspacePath: dir });
    const job = await waitForJob(jobs, (item) => item.status === "succeeded");

    expect(job.route).toBe("cheap");
    expect(job.routeReason).toContain("defaulting");
  });
});
