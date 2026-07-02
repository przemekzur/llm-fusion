import { describe, expect, it } from "vitest";
import { buildReport } from "../src/server/report.js";
import type { JobRecord } from "../src/shared/types.js";

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    goal: "Do a thing",
    workspacePath: "C:\\repo\\alpha",
    status: "succeeded",
    attempts: [],
    resultSummary: "",
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:03:00.000Z",
    ...overrides,
  };
}

const attempt = (label: string) => ({
  route: "cheap" as const,
  label,
  status: "succeeded" as const,
  summary: "",
  startedAt: "2026-07-02T10:00:00.000Z",
});

describe("report builder", () => {
  it("aggregates totals, routes, and projects with usage data", () => {
    const jobs = [
      job({ route: "cheap", attempts: [attempt("cheap solo")] }),
      job({
        route: "cheap",
        status: "failed",
        attempts: [attempt("cheap solo"), attempt("frontier solo (escalated)")],
        workspacePath: "C:\\repo\\beta",
      }),
      job({ route: "fusion", updatedAt: "2026-07-02T10:09:00.000Z" }),
    ];

    const usage = new Map(jobs.map((item, index) => [item.id, { totalTokens: (index + 1) * 1000, costUsd: index + 1 }]));
    const report = buildReport(jobs, (item) => usage.get(item.id)!);

    expect(report.totals).toMatchObject({
      jobs: 3,
      succeeded: 2,
      failed: 1,
      escalated: 1,
      totalTokens: 6000,
      costUsd: 6,
    });
    expect(report.totals.avgMinutes).toBe(5);

    const cheap = report.routes.find((row) => row.route === "cheap");
    expect(cheap).toMatchObject({ jobs: 2, succeeded: 1, escalated: 1, costUsd: 3 });

    expect(report.projects.map((row) => row.name).sort()).toEqual(["alpha", "beta"]);
    const alpha = report.projects.find((row) => row.name === "alpha");
    expect(alpha).toMatchObject({ jobs: 2, costUsd: 4 });

    // Newest first for the task table.
    expect(report.jobs[0]?.route).toBe("fusion");
  });

  it("handles an empty job list", () => {
    const report = buildReport([], () => ({ totalTokens: 0 }));
    expect(report.totals.jobs).toBe(0);
    expect(report.routes).toEqual([]);
    expect(report.projects).toEqual([]);
  });
});
