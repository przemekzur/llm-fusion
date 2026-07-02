import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { attachSessionWebSocket, resolveBindHost } from "../src/server/index.js";
import type { CliProbeRunner } from "../src/server/profileReadiness.js";
import type { PtyLike, SessionManager } from "../src/server/sessionManager.js";
import type { SessionRecord } from "../src/shared/types.js";

class FakePty extends EventEmitter implements PtyLike {
  public writes: string[] = [];
  public resized: Array<{ cols: number; rows: number }> = [];
  public killed = false;
  public pid = 1234;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", { exitCode: 0 });
  }

  onData(cb: (data: string) => void): { dispose(): void } {
    this.on("data", cb);
    return { dispose: () => this.off("data", cb) };
  }

  onExit(cb: (event: { exitCode?: number; signal?: number }) => void): { dispose(): void } {
    this.on("exit", cb);
    return { dispose: () => this.off("exit", cb) };
  }

  emitData(data: string): void {
    this.emit("data", data);
  }
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-api-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(options: { runCliProbe?: CliProbeRunner } = {}): { app: ReturnType<typeof createApp>["app"]; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const { app } = createApp({
    dataDir: dir,
    runCliProbe: options.runCliProbe,
    spawnPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });

  return { app, ptys };
}

describe("HTTP API", () => {
  it("keeps the default bind host loopback-only unless explicitly overridden", () => {
    const oldOverride = process.env.LLM_FUSION_ALLOW_UNSAFE_HOST;
    delete process.env.LLM_FUSION_ALLOW_UNSAFE_HOST;

    try {
      expect(resolveBindHost()).toBe("127.0.0.1");
      expect(resolveBindHost("localhost")).toBe("localhost");
      expect(resolveBindHost("::1")).toBe("::1");
      expect(() => resolveBindHost("0.0.0.0")).toThrow("Refusing to bind");

      process.env.LLM_FUSION_ALLOW_UNSAFE_HOST = "1";
      expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
    } finally {
      if (oldOverride === undefined) {
        delete process.env.LLM_FUSION_ALLOW_UNSAFE_HOST;
      } else {
        process.env.LLM_FUSION_ALLOW_UNSAFE_HOST = oldOverride;
      }
    }
  });

  it("reports health", async () => {
    const { app } = setup();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("runs launch profile readiness probes for selected profiles", async () => {
    const { app } = setup({
      runCliProbe: async (command) => ({
        exitCode: command.includes("codex-5.3") ? 1 : 0,
        stdout: command.includes("CLAUDE_OPUS_READY") ? "CLAUDE_OPUS_READY" : "",
        stderr: command.includes("codex-5.3") ? "codex-5.3 is not supported" : "",
        durationMs: 5,
      }),
    });

    const res = await request(app)
      .post("/api/e2e/readiness")
      .send({
        workspacePath: dir,
        profileIds: ["claude-opus-4-8-high", "codex-5-3-high"],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      {
        profileId: "claude-opus-4-8-high",
        status: "ready",
      },
      {
        profileId: "codex-5-3-high",
        status: "blocked",
      },
    ]);
    expect(res.body.results[1].evidence).toContain("not supported");
  });

  it("creates, lists, reads, writes, resizes, and stops sessions", async () => {
    const { app, ptys } = setup();

    const created = await request(app).post("/api/sessions").send({
      role: "coordinator",
      label: "Coordinator",
      command: "powershell.exe",
      cwd: dir,
      cols: 80,
      rows: 24,
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      role: "coordinator",
      label: "Coordinator",
      command: "powershell.exe",
      cwd: dir,
      status: "active",
    });

    const sessionId = created.body.id as string;
    ptys[0]?.emitData("ready\n");

    const listed = await request(app).get("/api/sessions");
    expect(listed.body.map((session: { id: string }) => session.id)).toEqual([sessionId]);

    const buffer = await request(app).get(`/api/sessions/${sessionId}/buffer`);
    expect(buffer.status).toBe(200);
    expect(buffer.body).toEqual({ buffer: "ready\n" });

    const input = await request(app).post(`/api/sessions/${sessionId}/input`).send({ input: "echo test" });
    expect(input.status).toBe(200);
    expect(input.body).toEqual({ ok: true });

    const resize = await request(app).post(`/api/sessions/${sessionId}/resize`).send({ cols: 120, rows: 40 });
    expect(resize.status).toBe(200);
    expect(resize.body).toEqual({ ok: true });

    const stopped = await request(app).post(`/api/sessions/${sessionId}/stop`).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ id: sessionId, status: "stopped" });
    expect(ptys[0]?.writes).toEqual(["echo test\r\n"]);
    expect(ptys[0]?.resized).toEqual([{ cols: 120, rows: 40 }]);
    expect(ptys[0]?.killed).toBe(true);
  });

  it("creates multiple sessions in one batch", async () => {
    const { app } = setup();

    const res = await request(app)
      .post("/api/sessions/batch")
      .send({
        sessions: [
          { role: "coordinator", label: "Coordinator", command: "powershell.exe", cwd: dir },
          { role: "sidekick", label: "Sidekick", command: "powershell.exe", cwd: dir },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.map((session: { role: string }) => session.role)).toEqual(["coordinator", "sidekick"]);

    const listed = await request(app).get("/api/sessions");
    expect(listed.body).toHaveLength(2);
  });

  it("creates and starts missions by writing a coordinator prompt", async () => {
    const { app, ptys } = setup();
    const coordinator = await request(app)
      .post("/api/sessions")
      .send({ role: "coordinator", label: "Coordinator", command: "powershell.exe", cwd: dir });
    const sidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Sidekick", command: "powershell.exe", cwd: dir });

    const created = await request(app)
      .post("/api/missions")
      .send({
        title: "Ship API",
        workspacePath: dir,
        routingMode: "manual",
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [sidekick.body.id],
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "Ship API",
      workspacePath: dir,
      status: "draft",
      routingMode: "manual",
      coordinatorSessionId: coordinator.body.id,
      sidekickSessionIds: [sidekick.body.id],
    });

    const missions = await request(app).get("/api/missions");
    expect(missions.body.map((mission: { id: string }) => mission.id)).toContain(created.body.id);

    const mission = await request(app).get(`/api/missions/${created.body.id}`);
    expect(mission.body.id).toBe(created.body.id);

    const started = await request(app)
      .post(`/api/missions/${created.body.id}/start`)
      .send({ prompt: "Implement Task 5" });

    expect(started.status).toBe(200);
    expect(started.body.status).toBe("running");
    await waitFor(() => {
      const written = ptys[0]?.writes.join("") ?? "";
      expect(written).toContain("Mission title: Ship API");
      expect(written).toContain("Mission prompt: Implement Task 5");
      expect(written).toContain("Sidekick");
    });
  });

  it("rejects invalid mission session roles and inactive coordinators", async () => {
    const { app } = setup();
    const coordinator = await request(app)
      .post("/api/sessions")
      .send({ role: "coordinator", label: "Coordinator", command: "powershell.exe", cwd: dir });
    const sidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Sidekick", command: "powershell.exe", cwd: dir });

    const sidekickAsCoordinator = await request(app)
      .post("/api/missions")
      .send({
        title: "Bad mission",
        workspacePath: dir,
        coordinatorSessionId: sidekick.body.id,
        sidekickSessionIds: [],
      });
    const coordinatorAsSidekick = await request(app)
      .post("/api/missions")
      .send({
        title: "Bad mission",
        workspacePath: dir,
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [coordinator.body.id],
      });

    await request(app).post(`/api/sessions/${coordinator.body.id}/stop`).send({});
    const stoppedCoordinator = await request(app)
      .post("/api/missions")
      .send({
        title: "Bad mission",
        workspacePath: dir,
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [sidekick.body.id],
      });

    expect(sidekickAsCoordinator.status).toBe(400);
    expect(sidekickAsCoordinator.body.error).toContain("Mission coordinator must be a coordinator session");
    expect(coordinatorAsSidekick.status).toBe(400);
    expect(coordinatorAsSidekick.body.error).toContain("Mission sidekick must be a sidekick session");
    expect(stoppedCoordinator.status).toBe(400);
    expect(stoppedCoordinator.body.error).toContain("Mission coordinator session is not active");
  });

  it("creates and sends tasks, then lists task.sent in the mission ledger", async () => {
    const { app, ptys } = setup();
    const coordinator = await request(app)
      .post("/api/sessions")
      .send({ role: "coordinator", label: "Coordinator", command: "powershell.exe", cwd: dir });
    const sidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Sidekick", command: "powershell.exe", cwd: dir });
    const mission = await request(app)
      .post("/api/missions")
      .send({
        title: "Ship API",
        workspacePath: dir,
        routingMode: "manual",
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [sidekick.body.id],
      });

    const created = await request(app)
      .post(`/api/missions/${mission.body.id}/tasks`)
      .send({
        title: "Run API tests",
        instructions: "Run npm test -- tests/api.test.ts and summarize failures.",
        assignedSessionId: sidekick.body.id,
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      missionId: mission.body.id,
      title: "Run API tests",
      status: "todo",
      createdBy: "operator",
      assignedSessionId: sidekick.body.id,
    });

    const tasks = await request(app).get(`/api/missions/${mission.body.id}/tasks`);
    expect(tasks.body.map((task: { id: string }) => task.id)).toEqual([created.body.id]);

    const sent = await request(app).post(`/api/tasks/${created.body.id}/send`).send({});
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    await waitFor(() => {
      const written = ptys[1]?.writes.join("") ?? "";
      expect(written).toContain("Task title: Run API tests");
      expect(written).toContain("Run npm test -- tests/api.test.ts");
    });

    const afterSend = await request(app).get(`/api/missions/${mission.body.id}/tasks`);
    expect(afterSend.body[0]?.status).toBe("sent");

    const ledger = await request(app).get(`/api/missions/${mission.body.id}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.map((event: { type: string }) => event.type)).toContain("task.sent");
    expect(ledger.body.find((event: { type: string }) => event.type === "task.sent")).toMatchObject({
      missionId: mission.body.id,
      targetSessionId: sidekick.body.id,
      taskId: created.body.id,
    });
  });

  it("rejects task routing to non-sidekick, unrelated, or inactive sessions", async () => {
    const { app } = setup();
    const coordinator = await request(app)
      .post("/api/sessions")
      .send({ role: "coordinator", label: "Coordinator", command: "powershell.exe", cwd: dir });
    const sidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Sidekick", command: "powershell.exe", cwd: dir });
    const otherSidekick = await request(app)
      .post("/api/sessions")
      .send({ role: "sidekick", label: "Other Sidekick", command: "powershell.exe", cwd: dir });
    const mission = await request(app)
      .post("/api/missions")
      .send({
        title: "Ship API",
        workspacePath: dir,
        routingMode: "manual",
        coordinatorSessionId: coordinator.body.id,
        sidekickSessionIds: [sidekick.body.id],
      });

    const coordinatorTask = await request(app)
      .post(`/api/missions/${mission.body.id}/tasks`)
      .send({
        title: "Wrong target",
        instructions: "Should fail.",
        assignedSessionId: coordinator.body.id,
      });
    const unrelatedTask = await request(app)
      .post(`/api/missions/${mission.body.id}/tasks`)
      .send({
        title: "Wrong target",
        instructions: "Should fail.",
        assignedSessionId: otherSidekick.body.id,
      });
    const task = await request(app)
      .post(`/api/missions/${mission.body.id}/tasks`)
      .send({
        title: "Valid target",
        instructions: "Should fail later after stop.",
        assignedSessionId: sidekick.body.id,
      });

    await request(app).post(`/api/sessions/${sidekick.body.id}/stop`).send({});
    const sentStopped = await request(app).post(`/api/tasks/${task.body.id}/send`).send({});

    expect(coordinatorTask.status).toBe(400);
    expect(coordinatorTask.body.error).toContain("Assigned task sidekick must be a sidekick session");
    expect(unrelatedTask.status).toBe(400);
    expect(unrelatedTask.body.error).toContain("Assigned session is not part of mission sidekicks");
    expect(sentStopped.status).toBe(400);
    expect(sentStopped.body.error).toContain("Assigned task sidekick session is not active");
  });

  it("returns JSON errors for missing resources and invalid operations", async () => {
    const { app } = setup();
    const missingBuffer = await request(app).get("/api/sessions/missing/buffer");
    const missingMission = await request(app).get("/api/missions/missing");
    const missingTask = await request(app).post("/api/tasks/missing/send").send({});

    expect(missingBuffer.status).toBe(404);
    expect(missingBuffer.body.error).toContain("Unknown session id");
    expect(missingMission.status).toBe(404);
    expect(missingMission.body.error).toContain("Mission not found");
    expect(missingTask.status).toBe(404);
    expect(missingTask.body.error).toContain("Task not found");
  });

  it("bridges session WebSocket replay, raw input, live output, invalid sessions, and listener disposal", async () => {
    const session: SessionRecord = {
      id: "session-valid",
      role: "coordinator",
      label: "Coordinator",
      command: "powershell.exe",
      cwd: dir,
      status: "active",
      createdAt: "2026-06-30T00:00:00.000Z",
      lastActiveAt: "2026-06-30T00:00:00.000Z",
      bufferTail: "past",
      logPath: join(dir, "logs", "session-valid.log"),
    };
    let outputHandler: ((id: string, chunk: string) => void) | undefined;
    let disposed = 0;
    const writeRaw = vi.fn();
    const manager = {
      getSession: (id: string) => (id === session.id ? session : undefined),
      readBuffer: () => "past",
      writeRaw,
      onOutput: (cb: (id: string, chunk: string) => void) => {
        outputHandler = cb;
        return { dispose: () => disposed++ };
      },
    } as unknown as SessionManager;
    const server = createServer();
    const wss = attachSessionWebSocket(server, manager);
    const port = await listen(server);

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions?id=${session.id}`);
      const replay = await nextMessage(socket);
      socket.send("x");
      await waitFor(() => expect(writeRaw).toHaveBeenCalledWith(session.id, "x"));

      outputHandler?.(session.id, "live");
      const live = await nextMessage(socket);
      const validClose = nextClose(socket);
      socket.close();
      await validClose;
      await waitFor(() => expect(disposed).toBe(1));

      const invalid = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions?id=missing`);
      const close = await nextClose(invalid);

      expect(JSON.parse(replay)).toEqual({ type: "replay", buffer: "past" });
      expect(JSON.parse(live)).toEqual({ type: "data", chunk: "live" });
      expect(close.code).toBe(1008);
    } finally {
      await closeWebSocketServer(wss);
      await closeServer(server);
    }
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => {
      socket.off("error", reject);
      resolve(data.toString());
    });
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", (code, reason) => {
      socket.off("error", reject);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 20000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
