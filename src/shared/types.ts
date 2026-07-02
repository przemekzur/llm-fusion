import { z } from "zod";

export const SessionRoleSchema = z.enum(["coordinator", "sidekick", "utility"]);
export const SessionStatusSchema = z.enum(["active", "exited", "failed", "stopped"]);
export const MissionStatusSchema = z.enum([
  "draft",
  "running",
  "paused",
  "needs_input",
  "reviewing",
  "complete",
  "failed",
  "cancelled",
]);
export const RoutingModeSchema = z.enum(["manual", "suggested", "auto-lite"]);
export const TaskStatusSchema = z.enum([
  "todo",
  "sent",
  "working",
  "blocked",
  "done",
  "reviewed",
  "cancelled",
]);
export const TaskCreatedBySchema = z.enum(["operator", "coordinator", "harness"]);

export const SessionRole = SessionRoleSchema;
export const SessionStatus = SessionStatusSchema;
export const MissionStatus = MissionStatusSchema;
export const RoutingMode = RoutingModeSchema;
export const TaskStatus = TaskStatusSchema;
export const TaskCreatedBy = TaskCreatedBySchema;

const IsoString = z.string().datetime();

export const SessionSchema = z.object({
  id: z.string().min(1),
  role: SessionRoleSchema,
  label: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: IsoString,
  lastActiveAt: IsoString,
  bufferTail: z.string(),
  logPath: z.string().min(1),
});

export const MissionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  workspacePath: z.string().min(1),
  status: MissionStatusSchema,
  routingMode: RoutingModeSchema,
  coordinatorSessionId: z.string().min(1),
  sidekickSessionIds: z.array(z.string().min(1)),
  createdAt: IsoString,
  updatedAt: IsoString,
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  assignedSessionId: z.string().min(1).optional(),
  status: TaskStatusSchema,
  createdBy: TaskCreatedBySchema,
  resultSummary: z.string(),
  createdAt: IsoString,
  updatedAt: IsoString,
});

export const JobRouteSchema = z.enum(["cheap", "frontier", "fusion"]);
export const JobStatusSchema = z.enum([
  "classifying",
  "running",
  "verifying",
  "escalating",
  "succeeded",
  "failed",
]);
export const JobAttemptStatusSchema = z.enum(["running", "succeeded", "verify_failed", "failed"]);

export const JobAttemptSchema = z.object({
  route: JobRouteSchema,
  label: z.string().min(1),
  status: JobAttemptStatusSchema,
  summary: z.string(),
  sessionId: z.string().min(1).optional(),
  startedAt: IsoString,
  endedAt: IsoString.optional(),
});

export const JobSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  workspacePath: z.string().min(1),
  verifyCommand: z.string().min(1).optional(),
  status: JobStatusSchema,
  route: JobRouteSchema.optional(),
  routeReason: z.string().optional(),
  attempts: z.array(JobAttemptSchema),
  resultSummary: z.string(),
  createdAt: IsoString,
  updatedAt: IsoString,
});

export const LedgerEventSchema = z.object({
  ts: IsoString,
  missionId: z.string().min(1).optional(),
  type: z.string().min(1),
  actor: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
  targetSessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string(),
  payload: z.record(z.unknown()).default({}),
});

export type SessionRole = z.infer<typeof SessionRoleSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type RoutingMode = z.infer<typeof RoutingModeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskCreatedBy = z.infer<typeof TaskCreatedBySchema>;
export type JobRoute = z.infer<typeof JobRouteSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobAttempt = z.infer<typeof JobAttemptSchema>;
export type JobRecord = z.infer<typeof JobSchema>;
export type SessionRecord = z.infer<typeof SessionSchema>;
export type MissionRecord = z.infer<typeof MissionSchema>;
export type TaskRecord = z.infer<typeof TaskSchema>;
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
