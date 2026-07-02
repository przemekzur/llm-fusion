import { describe, expect, it } from "vitest";
import {
  LedgerEventSchema,
  MissionSchema,
  SessionSchema,
  TaskSchema,
} from "../src/shared/types.js";

describe("shared schemas", () => {
  it("accepts valid session metadata", () => {
    const parsed = SessionSchema.parse({
      id: "session-coordinator-001",
      role: "coordinator",
      label: "Opus Coordinator",
      command: "claude",
      cwd: "C:\\code\\target",
      status: "active",
      createdAt: "2026-06-30T00:00:00.000Z",
      lastActiveAt: "2026-06-30T00:00:00.000Z",
      bufferTail: "ready",
      logPath: "data\\logs\\session-coordinator-001.log",
    });

    expect(parsed.role).toBe("coordinator");
  });

  it("rejects invalid routing modes", () => {
    expect(() =>
      MissionSchema.parse({
        id: "mission-001",
        title: "Ship feature",
        workspacePath: "C:\\repo",
        status: "draft",
        routingMode: "swarm",
        coordinatorSessionId: "session-coordinator-001",
        sidekickSessionIds: ["session-sidekick-001"],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts task and ledger records", () => {
    const task = TaskSchema.parse({
      id: "task-001",
      missionId: "mission-001",
      title: "Run tests",
      instructions: "Run npm test and summarize failures.",
      assignedSessionId: "session-sidekick-001",
      status: "todo",
      createdBy: "operator",
      resultSummary: "",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });

    const event = LedgerEventSchema.parse({
      ts: "2026-06-30T00:00:00.000Z",
      missionId: task.missionId,
      type: "task.sent",
      actor: "operator",
      sourceSessionId: "session-coordinator-001",
      targetSessionId: "session-sidekick-001",
      taskId: task.id,
      summary: "Sent tests to sidekick.",
      payload: {},
    });

    expect(event.taskId).toBe("task-001");
  });
});
