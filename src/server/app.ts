import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createAutopilot, type Autopilot } from "./autopilot.js";
import { createJsonStore } from "./jsonStore.js";
import { createLedgerStore } from "./ledgerStore.js";
import type { FusionDelegateMessage, FusionReportMessage } from "./fusionParser.js";
import { createFusionRouter, type FusionRouter } from "./fusionRouter.js";
import { runProfileReadiness, type CliProbeRunner } from "./profileReadiness.js";
import { buildReport } from "./report.js";
import { collectUsage, computeCostUsd, loadPriceDoc, totalTokens } from "./usage.js";
import { buildCoordinatorPrompt, buildSidekickPrompt } from "./prompts.js";
import { createSessionManager, type PtyLike, type SessionManager } from "./sessionManager.js";
import { defaultLaunchSlots, getLaunchProfile } from "../shared/launchProfiles.js";
import {
  JobSchema,
  MissionSchema,
  RoutingModeSchema,
  TaskCreatedBySchema,
  TaskSchema,
  SessionRoleSchema,
  type JobRecord,
  type LedgerEvent,
  type MissionRecord,
  type SessionRecord,
  type TaskRecord,
} from "../shared/types.js";

export interface CreateAppOptions {
  dataDir: string;
  staticDir?: string;
  spawnPty?: (input: Parameters<SessionManager["createSession"]>[0]) => PtyLike;
  runCliProbe?: CliProbeRunner;
  runJobCommand?: CliProbeRunner;
  typedInputDelayMs?: number;
}

export interface CreatedApp {
  app: express.Express;
  sessionManager: SessionManager;
  fusionRouter: FusionRouter;
  autopilot: Autopilot;
}

const CreateSessionRequestSchema = z.object({
  role: SessionRoleSchema,
  label: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

const CreateSessionBatchRequestSchema = z.object({
  sessions: z.array(CreateSessionRequestSchema).min(1),
});

const ResizeRequestSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const InputRequestSchema = z.object({
  input: z.string(),
});

const CreateMissionRequestSchema = z.object({
  title: z.string().min(1),
  workspacePath: z.string().min(1),
  routingMode: RoutingModeSchema.default("manual"),
  coordinatorSessionId: z.string().min(1),
  sidekickSessionIds: z.array(z.string().min(1)).default([]),
});

const StartMissionRequestSchema = z.object({
  prompt: z.string().min(1).optional(),
});

const CreateTaskRequestSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().min(1),
  assignedSessionId: z.string().min(1).optional(),
  createdBy: TaskCreatedBySchema.default("operator"),
});

const ReadinessRequestSchema = z.object({
  workspacePath: z.string().min(1).optional(),
  profileIds: z.array(z.string().min(1)).optional(),
});

const CreateJobRequestSchema = z.object({
  goal: z.string().min(1),
  workspacePath: z.string().min(1),
  verifyCommand: z.string().min(1).optional(),
  route: z.enum(["cheap", "frontier", "fusion"]).optional(),
});

function parseBody<TSchema extends z.ZodTypeAny>(
  res: Response,
  schema: TSchema,
  body: unknown,
): z.infer<TSchema> | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  res.status(400).json({
    error: "Invalid request body",
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
  return undefined;
}

function jsonError(res: Response, status: number, error: string): Response {
  return res.status(status).json({ error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionErrorStatus(error: unknown): number {
  return errorMessage(error).startsWith("Unknown session id:") ? 404 : 400;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ledgerEvent(event: Omit<LedgerEvent, "ts" | "payload"> & { payload?: LedgerEvent["payload"] }): LedgerEvent {
  return {
    ts: nowIso(),
    payload: {},
    ...event,
  };
}

export function createApp(options: CreateAppOptions): CreatedApp {
  const app = express();
  const sessionManager = createSessionManager({
    dataDir: options.dataDir,
    spawnPty: options.spawnPty,
    typedInputDelayMs: options.typedInputDelayMs,
  });
  const missions = createJsonStore<MissionRecord[]>(
    join(options.dataDir, "missions.json"),
    [],
    z.array(MissionSchema),
  );
  const tasks = createJsonStore<TaskRecord[]>(join(options.dataDir, "tasks.json"), [], z.array(TaskSchema));
  const ledger = createLedgerStore(join(options.dataDir, "ledger.jsonl"));

  function findMission(id: string): MissionRecord | undefined {
    return missions.read().find((mission) => mission.id === id);
  }

  function findTask(id: string): TaskRecord | undefined {
    return tasks.read().find((task) => task.id === id);
  }

  function updateMission(id: string, mutator: (mission: MissionRecord) => MissionRecord): MissionRecord | undefined {
    let updated: MissionRecord | undefined;
    missions.update((items) =>
      items.map((mission) => {
        if (mission.id !== id) return mission;
        updated = mutator(mission);
        return updated;
      }),
    );
    return updated;
  }

  function updateTask(id: string, mutator: (task: TaskRecord) => TaskRecord): TaskRecord | undefined {
    let updated: TaskRecord | undefined;
    tasks.update((items) =>
      items.map((task) => {
        if (task.id !== id) return task;
        updated = mutator(task);
        return updated;
      }),
    );
    return updated;
  }

  function requireSession(res: Response, id: string): boolean {
    if (sessionManager.getSession(id)) return true;
    jsonError(res, 404, `Unknown session id: ${id}`);
    return false;
  }

  function requireSessionRecord(res: Response, id: string): SessionRecord | undefined {
    const session = sessionManager.getSession(id);
    if (session) return session;
    jsonError(res, 404, `Unknown session id: ${id}`);
    return undefined;
  }

  function requireActiveRole(
    res: Response,
    id: string,
    role: SessionRecord["role"],
    label: string,
  ): SessionRecord | undefined {
    const session = requireSessionRecord(res, id);
    if (!session) return undefined;
    if (session.role !== role) {
      jsonError(res, 400, `${label} must be a ${role} session: ${id}`);
      return undefined;
    }
    if (session.status !== "active") {
      jsonError(res, 400, `${label} session is not active: ${id}`);
      return undefined;
    }
    return session;
  }

  function requireMissionSidekick(res: Response, mission: MissionRecord, sessionId: string): boolean {
    if (!requireActiveRole(res, sessionId, "sidekick", "Assigned task sidekick")) return false;
    if (!mission.sidekickSessionIds.includes(sessionId)) {
      jsonError(res, 400, `Assigned session is not part of mission sidekicks: ${sessionId}`);
      return false;
    }
    return true;
  }

  function insertTask(
    mission: MissionRecord,
    input: {
      title: string;
      instructions: string;
      assignedSessionId?: string;
      createdBy: TaskRecord["createdBy"];
    },
  ): TaskRecord {
    const createdAt = nowIso();
    const task: TaskRecord = {
      id: `task-${randomUUID()}`,
      missionId: mission.id,
      title: input.title,
      instructions: input.instructions,
      assignedSessionId: input.assignedSessionId,
      status: "todo",
      createdBy: input.createdBy,
      resultSummary: "",
      createdAt,
      updatedAt: createdAt,
    };

    tasks.update((items) => [...items, task]);
    ledger.append(
      ledgerEvent({
        missionId: mission.id,
        type: "task.created",
        actor: task.createdBy,
        targetSessionId: task.assignedSessionId,
        taskId: task.id,
        summary: `Created task ${task.title}.`,
        payload: {},
      }),
    );
    return task;
  }

  function dispatchTask(task: TaskRecord, mission: MissionRecord, actor: string): void {
    if (!task.assignedSessionId) throw new Error(`Task has no assigned session: ${task.id}`);

    const prompt = buildSidekickPrompt({
      missionTitle: mission.title,
      workspacePath: mission.workspacePath,
      taskTitle: task.title,
      taskInstructions: task.instructions,
      taskId: task.id,
    });

    fusionRouter.noteInjected(task.assignedSessionId, prompt);
    sessionManager.writeInput(task.assignedSessionId, prompt);

    updateTask(task.id, (current) => ({
      ...current,
      status: "sent",
      updatedAt: nowIso(),
    }));
    ledger.append(
      ledgerEvent({
        missionId: mission.id,
        type: "task.sent",
        actor,
        targetSessionId: task.assignedSessionId,
        taskId: task.id,
        summary: `Sent task ${task.title}.`,
        payload: {},
      }),
    );
  }

  function pickSidekick(mission: MissionRecord): SessionRecord | undefined {
    const active = mission.sidekickSessionIds
      .map((sessionId) => sessionManager.getSession(sessionId))
      .filter(
        (session): session is SessionRecord =>
          !!session && session.role === "sidekick" && session.status === "active",
      );
    if (!active.length) return undefined;

    const openTasks = tasks
      .read()
      .filter((task) => task.missionId === mission.id && (task.status === "sent" || task.status === "working"));
    const load = (sessionId: string) => openTasks.filter((task) => task.assignedSessionId === sessionId).length;
    return active.slice().sort((a, b) => load(a.id) - load(b.id))[0];
  }

  function handleDelegate(sessionId: string, message: FusionDelegateMessage): void {
    const mission = missions
      .read()
      .filter((item) => item.status === "running" && item.coordinatorSessionId === sessionId)
      .at(-1);
    if (!mission) return;

    const chosen = pickSidekick(mission);
    const assignedSessionId = mission.routingMode === "manual" ? undefined : chosen?.id;
    const instructions = [
      message.instructions,
      message.allowedFiles?.length ? `Allowed files: ${message.allowedFiles.join(", ")}` : "",
      message.readOnly ? "This task is read-only. Do not write files or change repository state." : "",
    ]
      .filter(Boolean)
      .join("\n");

    const task = insertTask(mission, {
      title: message.title,
      instructions,
      assignedSessionId,
      createdBy: "coordinator",
    });

    if (mission.routingMode === "auto-lite" && chosen) {
      try {
        dispatchTask(task, mission, "harness");
      } catch (error) {
        ledger.append(
          ledgerEvent({
            missionId: mission.id,
            type: "fusion.error",
            actor: "harness",
            taskId: task.id,
            summary: `Auto-send failed: ${errorMessage(error)}`,
            payload: {},
          }),
        );
      }
    }
  }

  function handleReport(sessionId: string, message: FusionReportMessage): void {
    const task = findTask(message.task);
    if (!task || task.assignedSessionId !== sessionId) return;
    if (task.status === "done" || task.status === "blocked" || task.status === "reviewed" || task.status === "cancelled") {
      return;
    }

    const summary = message.summary.replaceAll("@@FUSION", "[fusion]").slice(0, 1000);
    const status = message.status === "done" ? "done" : "blocked";
    updateTask(task.id, (current) => ({
      ...current,
      status,
      resultSummary: summary,
      updatedAt: nowIso(),
    }));

    const mission = findMission(task.missionId);
    ledger.append(
      ledgerEvent({
        missionId: task.missionId,
        type: "task.reported",
        actor: "harness",
        sourceSessionId: sessionId,
        taskId: task.id,
        summary: `Sidekick reported ${status}: ${summary.slice(0, 160)}`,
        payload: { status },
      }),
    );

    if (!mission || mission.status !== "running") return;
    const coordinator = sessionManager.getSession(mission.coordinatorSessionId);
    if (!coordinator || coordinator.status !== "active") return;

    const sidekickLabel = sessionManager.getSession(sessionId)?.label ?? sessionId;
    const text = `Fusion report from sidekick "${sidekickLabel}" for task "${task.title}" (${status}): ${summary}`;
    fusionRouter.noteInjected(mission.coordinatorSessionId, text);
    try {
      sessionManager.writeInput(mission.coordinatorSessionId, text);
    } catch (error) {
      ledger.append(
        ledgerEvent({
          missionId: mission.id,
          type: "fusion.error",
          actor: "harness",
          taskId: task.id,
          summary: `Report relay failed: ${errorMessage(error)}`,
          payload: {},
        }),
      );
    }
  }

  const fusionRouter = createFusionRouter({
    sessionManager,
    onDelegate: handleDelegate,
    onReport: handleReport,
  });

  const jobs = createJsonStore<JobRecord[]>(join(options.dataDir, "jobs.json"), [], z.array(JobSchema));
  const autopilot = createAutopilot({
    jobs,
    appendLedger: (event) => ledger.append(ledgerEvent(event)),
    runCommand: options.runJobCommand,
    sessionManager: options.runJobCommand ? undefined : sessionManager,
  });

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ defaultWorkspace: process.cwd() });
  });

  app.post("/api/e2e/readiness", async (req, res) => {
    const input = parseBody(res, ReadinessRequestSchema, req.body ?? {});
    if (!input) return;

    const profileIds = input.profileIds ?? Array.from(new Set(defaultLaunchSlots.map((slot) => slot.defaultProfileId)));
    const results = [];

    for (const profileId of profileIds) {
      let profile;
      try {
        profile = getLaunchProfile(profileId);
      } catch (error) {
        return jsonError(res, 400, errorMessage(error));
      }

      results.push(
        await runProfileReadiness({
          cwd: input.workspacePath ?? options.dataDir,
          profile,
          runCommand: options.runCliProbe,
        }),
      );
    }

    return res.json({ results });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(sessionManager.listSessions());
  });

  app.post("/api/sessions", (req, res) => {
    const input = parseBody(res, CreateSessionRequestSchema, req.body);
    if (!input) return;

    const session = sessionManager.createSession(input);
    ledger.append(
      ledgerEvent({
        type: "session.created",
        actor: "operator",
        targetSessionId: session.id,
        summary: `Created session ${session.label}.`,
        payload: { role: session.role, command: session.command, cwd: session.cwd },
      }),
    );
    res.status(201).json(session);
  });

  app.post("/api/sessions/batch", (req, res) => {
    const input = parseBody(res, CreateSessionBatchRequestSchema, req.body);
    if (!input) return;

    const created = input.sessions.map((sessionInput) => {
      const session = sessionManager.createSession(sessionInput);
      ledger.append(
        ledgerEvent({
          type: "session.created",
          actor: "operator",
          targetSessionId: session.id,
          summary: `Created session ${session.label}.`,
          payload: { role: session.role, command: session.command, cwd: session.cwd },
        }),
      );
      return session;
    });

    res.status(201).json(created);
  });

  app.post("/api/sessions/:id/input", (req, res) => {
    const input = parseBody(res, InputRequestSchema, req.body);
    if (!input) return;

    try {
      sessionManager.writeInput(req.params.id, input.input);
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }
  });

  app.post("/api/sessions/:id/resize", (req, res) => {
    const input = parseBody(res, ResizeRequestSchema, req.body);
    if (!input) return;

    try {
      sessionManager.resize(req.params.id, input.cols, input.rows);
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      sessionManager.stop(req.params.id);
      res.json(sessionManager.getSession(req.params.id));
    } catch (error) {
      jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }
  });

  app.get("/api/sessions/:id/buffer", (req, res) => {
    try {
      res.json({ buffer: sessionManager.readBuffer(req.params.id) });
    } catch (error) {
      jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }
  });

  // Local folder browser for the workspace picker (loopback-only server).
  app.get("/api/fs/dirs", (req, res) => {
    const requested = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path : homedir();
    const path = resolve(requested);
    if (!existsSync(path)) return jsonError(res, 400, `Path does not exist: ${path}`);

    try {
      const dirs = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith(".") && name !== "node_modules")
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, path: join(path, name) }));
      const parent = dirname(path);
      return res.json({ path, parent: parent !== path ? parent : undefined, dirs });
    } catch (error) {
      return jsonError(res, 400, errorMessage(error));
    }
  });

  app.get("/api/report", (_req, res) => {
    const priceDoc = loadPriceDoc();
    const report = buildReport(autopilot.listJobs(), (job) => {
      try {
        const usage = collectUsage({
          workspace: job.workspacePath,
          sinceMs: Date.parse(job.createdAt) - 30_000,
          untilMs: Date.parse(job.updatedAt) + 30_000,
        });
        return { totalTokens: totalTokens(usage), costUsd: computeCostUsd(usage, priceDoc) };
      } catch {
        return { totalTokens: 0 };
      }
    });
    res.json(report);
  });

  app.get("/api/jobs", (_req, res) => {
    res.json(autopilot.listJobs());
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = autopilot.getJob(req.params.id);
    if (!job) return jsonError(res, 404, `Job not found: ${req.params.id}`);
    return res.json(job);
  });

  app.post("/api/jobs", (req, res) => {
    const input = parseBody(res, CreateJobRequestSchema, req.body);
    if (!input) return;
    if (!existsSync(input.workspacePath)) {
      return jsonError(res, 400, `Workspace path does not exist: ${input.workspacePath}`);
    }
    return res.status(201).json(autopilot.createJob(input));
  });

  app.get("/api/missions", (_req, res) => {
    res.json(missions.read());
  });

  app.post("/api/missions", (req, res) => {
    const input = parseBody(res, CreateMissionRequestSchema, req.body);
    if (!input) return;
    if (!requireActiveRole(res, input.coordinatorSessionId, "coordinator", "Mission coordinator")) return;

    for (const sessionId of input.sidekickSessionIds) {
      if (!requireActiveRole(res, sessionId, "sidekick", "Mission sidekick")) return;
    }

    const createdAt = nowIso();
    const mission: MissionRecord = {
      id: `mission-${randomUUID()}`,
      title: input.title,
      workspacePath: input.workspacePath,
      status: "draft",
      routingMode: input.routingMode,
      coordinatorSessionId: input.coordinatorSessionId,
      sidekickSessionIds: input.sidekickSessionIds,
      createdAt,
      updatedAt: createdAt,
    };

    missions.update((items) => [...items, mission]);
    ledger.append(
      ledgerEvent({
        missionId: mission.id,
        type: "mission.created",
        actor: "operator",
        sourceSessionId: mission.coordinatorSessionId,
        summary: `Created mission ${mission.title}.`,
        payload: { routingMode: mission.routingMode, workspacePath: mission.workspacePath },
      }),
    );
    res.status(201).json(mission);
  });

  app.get("/api/missions/:id", (req, res) => {
    const mission = findMission(req.params.id);
    if (!mission) return jsonError(res, 404, `Mission not found: ${req.params.id}`);
    return res.json(mission);
  });

  app.post("/api/missions/:id/start", (req, res) => {
    const input = parseBody(res, StartMissionRequestSchema, req.body ?? {});
    if (!input) return;

    const mission = findMission(req.params.id);
    if (!mission) return jsonError(res, 404, `Mission not found: ${req.params.id}`);
    if (!requireActiveRole(res, mission.coordinatorSessionId, "coordinator", "Mission coordinator")) return;

    const sidekickLabels = mission.sidekickSessionIds
      .map((sessionId) => sessionManager.getSession(sessionId)?.label)
      .filter((label): label is string => Boolean(label));
    const prompt = buildCoordinatorPrompt({
      missionTitle: mission.title,
      missionPrompt: input.prompt ?? mission.title,
      workspacePath: mission.workspacePath,
      sidekickLabels,
    });

    try {
      fusionRouter.noteInjected(mission.coordinatorSessionId, prompt);
      sessionManager.writeInput(mission.coordinatorSessionId, prompt);
    } catch (error) {
      return jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }

    const updated = updateMission(mission.id, (current) => ({
      ...current,
      status: "running",
      updatedAt: nowIso(),
    }));

    ledger.append(
      ledgerEvent({
        missionId: mission.id,
        type: "mission.started",
        actor: "operator",
        sourceSessionId: mission.coordinatorSessionId,
        summary: `Started mission ${mission.title}.`,
        payload: {},
      }),
    );
    return res.json(updated);
  });

  app.get("/api/missions/:id/tasks", (req, res) => {
    const mission = findMission(req.params.id);
    if (!mission) return jsonError(res, 404, `Mission not found: ${req.params.id}`);
    return res.json(tasks.read().filter((task) => task.missionId === mission.id));
  });

  app.post("/api/missions/:id/tasks", (req, res) => {
    const input = parseBody(res, CreateTaskRequestSchema, req.body);
    if (!input) return;

    const mission = findMission(req.params.id);
    if (!mission) return jsonError(res, 404, `Mission not found: ${req.params.id}`);
    if (input.assignedSessionId && !requireMissionSidekick(res, mission, input.assignedSessionId)) return;

    const task = insertTask(mission, input);
    res.status(201).json(task);
  });

  app.post("/api/tasks/:id/send", (req, res) => {
    const task = findTask(req.params.id);
    if (!task) return jsonError(res, 404, `Task not found: ${req.params.id}`);
    if (!task.assignedSessionId) return jsonError(res, 400, `Task has no assigned session: ${task.id}`);

    const mission = findMission(task.missionId);
    if (!mission) return jsonError(res, 400, `Task mission not found: ${task.missionId}`);
    if (!requireMissionSidekick(res, mission, task.assignedSessionId)) return;

    try {
      dispatchTask(task, mission, "operator");
    } catch (error) {
      return jsonError(res, sessionErrorStatus(error), errorMessage(error));
    }

    return res.json({ ok: true });
  });

  app.get("/api/missions/:id/ledger", (req, res) => {
    const mission = findMission(req.params.id);
    if (!mission) return jsonError(res, 404, `Mission not found: ${req.params.id}`);
    return res.json(ledger.list(mission.id));
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const message = errorMessage(error);
    const status = message.includes("JSON") ? 400 : 500;
    res.status(status).json({ error: status === 400 ? "Invalid JSON body" : "Internal server error" });
  });

  return { app, sessionManager, fusionRouter, autopilot };
}
