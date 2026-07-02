import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

let dir = "";
let appContext: ReturnType<typeof createApp> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-smoke-"));
});

afterEach(() => {
  for (const session of appContext?.sessionManager.listSessions() ?? []) {
    if (session.status === "active") {
      appContext?.sessionManager.stop(session.id);
    }
  }
  appContext = undefined;
  removeTempDir(dir);
});

function commandForPlatform(): string {
  return process.platform === "win32" ? "powershell.exe" : "bash";
}

async function waitForBuffer(app: ReturnType<typeof createApp>["app"], sessionId: string, marker: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/sessions/${sessionId}/buffer`);
    const buffer = String(res.body.buffer || "");
    if (buffer.includes(marker)) return buffer;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Marker ${marker} not found in terminal buffer`);
}

describe("local fusion smoke", () => {
  it("runs a local terminal command, creates a mission, sends a task, and records the ledger", async () => {
    appContext = createApp({ dataDir: dir });
    const { app } = appContext;
    const command = commandForPlatform();
    const coordinator = await request(app)
      .post("/api/sessions")
      .send({ role: "coordinator", label: "Smoke Coordinator", command, cwd: dir });
    const sidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Smoke Sidekick", command, cwd: dir });

    expect(coordinator.status).toBe(201);
    expect(sidekick.status).toBe(201);

    await request(app).post(`/api/sessions/${coordinator.body.id}/input`).send({ input: "echo FUSION_SMOKE" });
    await waitForBuffer(app, coordinator.body.id, "FUSION_SMOKE");

    const mission = await request(app)
      .post("/api/missions")
      .send({
        title: "Smoke mission",
        workspacePath: dir,
        routingMode: "manual",
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [sidekick.body.id],
      });
    expect(mission.status).toBe(201);

    const task = await request(app)
      .post(`/api/missions/${mission.body.id}/tasks`)
      .send({
        title: "Echo marker",
        instructions: "Run echo TASK_SENT_MARKER and report the result.",
        assignedSessionId: sidekick.body.id,
      });
    expect(task.status).toBe(201);

    const sent = await request(app).post(`/api/tasks/${task.body.id}/send`).send({});
    expect(sent.status).toBe(200);

    const ledger = await request(app).get(`/api/missions/${mission.body.id}/ledger`);
    expect(ledger.body.map((event: { type: string }) => event.type)).toContain("task.sent");

    await request(app).post(`/api/sessions/${coordinator.body.id}/stop`).send({});
    await request(app).post(`/api/sessions/${sidekick.body.id}/stop`).send({});
  }, 45_000);
});

function removeTempDir(path: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  throw lastError;
}
