import type { JobRecord } from "../shared/types.js";

export interface ReportJobRow {
  id: string;
  goal: string;
  workspacePath: string;
  route?: string;
  status: string;
  attempts: number;
  escalated: boolean;
  minutes: number;
  totalTokens: number;
  costUsd?: number;
}

export interface ReportRouteRow {
  route: string;
  jobs: number;
  succeeded: number;
  escalated: number;
  avgMinutes: number;
  totalTokens: number;
  costUsd: number;
}

export interface ReportProjectRow {
  path: string;
  name: string;
  jobs: number;
  succeeded: number;
  totalTokens: number;
  costUsd: number;
}

export interface HarnessReport {
  generatedAt: string;
  totals: {
    jobs: number;
    succeeded: number;
    failed: number;
    active: number;
    escalated: number;
    totalTokens: number;
    costUsd: number;
    avgMinutes: number;
  };
  routes: ReportRouteRow[];
  projects: ReportProjectRow[];
  jobs: ReportJobRow[];
}

export interface JobUsage {
  totalTokens: number;
  costUsd?: number;
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.round(((Date.parse(endIso) - Date.parse(startIso)) / 60000) * 10) / 10);
}

function projectName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function buildReport(jobs: JobRecord[], usageFor: (job: JobRecord) => JobUsage): HarnessReport {
  const rows: ReportJobRow[] = jobs.map((job) => {
    const usage = usageFor(job);
    return {
      id: job.id,
      goal: job.goal,
      workspacePath: job.workspacePath,
      route: job.route,
      status: job.status,
      attempts: job.attempts.length,
      escalated: job.attempts.some((attempt) => attempt.label.includes("escalated")),
      minutes: minutesBetween(job.createdAt, job.updatedAt),
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
    };
  });

  const groupBy = <K extends string>(key: (row: ReportJobRow) => K): Map<K, ReportJobRow[]> => {
    const groups = new Map<K, ReportJobRow[]>();
    for (const row of rows) {
      const groupKey = key(row);
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
    }
    return groups;
  };

  const sum = (list: ReportJobRow[], pick: (row: ReportJobRow) => number) =>
    list.reduce((total, row) => total + pick(row), 0);

  const routes: ReportRouteRow[] = [...groupBy((row) => row.route ?? "unrouted").entries()]
    .map(([route, list]) => ({
      route,
      jobs: list.length,
      succeeded: list.filter((row) => row.status === "succeeded").length,
      escalated: list.filter((row) => row.escalated).length,
      avgMinutes: list.length ? Math.round((sum(list, (row) => row.minutes) / list.length) * 10) / 10 : 0,
      totalTokens: sum(list, (row) => row.totalTokens),
      costUsd: round(sum(list, (row) => row.costUsd ?? 0)),
    }))
    .sort((a, b) => b.jobs - a.jobs);

  const projects: ReportProjectRow[] = [...groupBy((row) => row.workspacePath).entries()]
    .map(([path, list]) => ({
      path,
      name: projectName(path),
      jobs: list.length,
      succeeded: list.filter((row) => row.status === "succeeded").length,
      totalTokens: sum(list, (row) => row.totalTokens),
      costUsd: round(sum(list, (row) => row.costUsd ?? 0)),
    }))
    .sort((a, b) => b.jobs - a.jobs);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      jobs: rows.length,
      succeeded: rows.filter((row) => row.status === "succeeded").length,
      failed: rows.filter((row) => row.status === "failed").length,
      active: rows.filter((row) => row.status !== "succeeded" && row.status !== "failed").length,
      escalated: rows.filter((row) => row.escalated).length,
      totalTokens: sum(rows, (row) => row.totalTokens),
      costUsd: round(sum(rows, (row) => row.costUsd ?? 0)),
      avgMinutes: rows.length ? Math.round((sum(rows, (row) => row.minutes) / rows.length) * 10) / 10 : 0,
    },
    routes,
    projects,
    jobs: rows.slice().reverse(),
  };
}
