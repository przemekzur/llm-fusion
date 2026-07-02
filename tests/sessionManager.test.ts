import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPtyEnv, createSessionManager, resolvePtySpawnCommand, type PtyLike } from "../src/server/sessionManager.js";

class FakePty extends EventEmitter implements PtyLike {
  public writes: string[] = [];
  public killed = false;
  public resized: Array<{ cols: number; rows: number }> = [];
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

  emitExit(exitCode = 0): void {
    this.emit("exit", { exitCode });
  }
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-session-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("session manager", () => {
  it("sets local CLI automation environment defaults without overwriting explicit values", () => {
    expect(buildPtyEnv({ PATH: "x" })).toMatchObject({
      PATH: "x",
      NO_UPDATE_NOTIFIER: "1",
      CODEX_DISABLE_UPDATE_CHECK: "1",
    });
    expect(buildPtyEnv({ NO_UPDATE_NOTIFIER: "0", CODEX_DISABLE_UPDATE_CHECK: "0" })).toMatchObject({
      NO_UPDATE_NOTIFIER: "0",
      CODEX_DISABLE_UPDATE_CHECK: "0",
    });
  });

  it("resolves configured commands as the PTY executable instead of wrapping a default shell", () => {
    const command = resolvePtySpawnCommand('codex --model "opus high"');
    const windowsPathCommand = resolvePtySpawnCommand('"C:\\Tools\\agent.exe" --flag');

    if (process.platform === "win32") {
      expect(command.file.toLowerCase()).toMatch(/codex\.(com|exe|bat|cmd)$/);
    } else {
      expect(command.file.toLowerCase()).toMatch(/codex$/);
    }
    expect(command.args).toEqual(["--model", "opus high"]);
    expect(command.displayCommand).toBe('codex --model "opus high"');
    expect(windowsPathCommand.file).toBe("C:\\Tools\\agent.exe");
    expect(windowsPathCommand.args).toEqual(["--flag"]);
  });

  it("creates active session records with logs under the configured data directory", () => {
    const ptys: FakePty[] = [];
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });

    const session = manager.createSession({
      role: "coordinator",
      label: "Coordinator",
      command: "powershell.exe",
      cwd: dir,
      cols: 80,
      rows: 24,
    });

    expect(session.id).toMatch(/^session-/);
    expect(session.status).toBe("active");
    expect(session.createdAt).toBe(session.lastActiveAt);
    expect(session.bufferTail).toBe("");
    expect(dirname(session.logPath)).toBe(join(dir, "logs"));
    expect(basename(session.logPath)).toBe(`${session.id}.log`);
    expect(ptys).toHaveLength(1);
  });

  it("buffers output, trims scrollback, appends full logs, and notifies listeners", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));

    const ptys: FakePty[] = [];
    const manager = createSessionManager({
      dataDir: dir,
      scrollbackLimit: 10,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const seen: Array<{ id: string; chunk: string }> = [];
    manager.onOutput((id, chunk) => seen.push({ id, chunk }));

    const session = manager.createSession({
      role: "sidekick",
      label: "Sidekick",
      command: "codex",
      cwd: dir,
    });

    vi.setSystemTime(new Date("2026-06-30T00:00:01.000Z"));
    ptys[0]?.emitData("1234567890");
    ptys[0]?.emitData("abcdef");

    expect(manager.readBuffer(session.id)).toBe("7890abcdef");
    expect(manager.getSession(session.id)?.bufferTail).toBe("7890abcdef");
    expect(readFileSync(session.logPath, "utf8")).toBe("1234567890abcdef");
    expect(seen).toEqual([
      { id: session.id, chunk: "1234567890" },
      { id: session.id, chunk: "abcdef" },
    ]);
    expect(manager.getSession(session.id)?.lastActiveAt).toBe("2026-06-30T00:00:01.000Z");
  });

  it("records failed sessions when PTY startup throws", () => {
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => {
        throw new Error("missing executable");
      },
    });

    const session = manager.createSession({
      role: "sidekick",
      label: "Broken Sidekick",
      command: "missing-cli",
      cwd: dir,
    });

    expect(session.status).toBe("failed");
    expect(manager.getSession(session.id)?.bufferTail).toContain("missing executable");
    expect(manager.readBuffer(session.id)).toContain("missing executable");
    expect(readFileSync(session.logPath, "utf8")).toContain("missing executable");
    expect(() => manager.writeInput(session.id, "echo nope")).toThrow(`Session is not active: ${session.id}`);
  });

  it("writes line input with CRLF, writes raw input as-is, and resizes the PTY", () => {
    const pty = new FakePty();
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => pty,
    });
    const session = manager.createSession({
      role: "utility",
      label: "Utility",
      command: "bash",
      cwd: dir,
    });

    manager.writeInput(session.id, "echo test");
    manager.writeRaw(session.id, "\u0003");
    manager.resize(session.id, 120, 40);

    expect(pty.writes).toEqual(["echo test\r\n", "\u0003"]);
    expect(pty.resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("normalizes multiline API input into one submitted terminal line", () => {
    const pty = new FakePty();
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => pty,
    });
    const session = manager.createSession({
      role: "coordinator",
      label: "Coordinator",
      command: "claude",
      cwd: dir,
    });

    manager.writeInput(session.id, "line one\nline two\r\nline three");

    expect(pty.writes).toEqual(["line one | line two | line three\r\n"]);
  });

  it("submits long input as one bracketed paste followed by Enter", () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => pty,
    });
    const session = manager.createSession({
      role: "coordinator",
      label: "Coordinator",
      command: "claude",
      cwd: dir,
    });
    const input = "x".repeat(260);

    manager.writeInput(session.id, input);

    expect(pty.writes).toEqual([`\x1b[200~${input}\x1b[201~`]);
    vi.runAllTimers();
    expect(pty.writes.at(-1)).toBe("\r");
  });

  it("marks stopped sessions without letting the PTY exit event override the status", () => {
    const pty = new FakePty();
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => pty,
    });
    const session = manager.createSession({
      role: "sidekick",
      label: "Sidekick",
      command: "powershell.exe",
      cwd: dir,
    });

    manager.stop(session.id);

    expect(pty.killed).toBe(true);
    expect(manager.getSession(session.id)?.status).toBe("stopped");
  });

  it("marks active sessions as exited when the PTY exits", () => {
    const pty = new FakePty();
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => pty,
    });
    const session = manager.createSession({
      role: "sidekick",
      label: "Sidekick",
      command: "powershell.exe",
      cwd: dir,
    });

    pty.emitExit(0);

    expect(manager.getSession(session.id)?.status).toBe("exited");
  });

  it("lists, gets, and reads sessions from in-memory state", () => {
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => new FakePty(),
    });
    const first = manager.createSession({
      role: "coordinator",
      label: "Coordinator",
      command: "powershell.exe",
      cwd: dir,
    });
    const second = manager.createSession({
      role: "sidekick",
      label: "Sidekick",
      command: "powershell.exe",
      cwd: dir,
    });

    expect(manager.listSessions().map((session) => session.id)).toEqual([first.id, second.id]);
    expect(manager.getSession(first.id)?.label).toBe("Coordinator");
    expect(manager.getSession("missing")).toBeUndefined();
    expect(manager.readBuffer(second.id)).toBe("");
  });

  it("throws a clear error for unknown session ids", () => {
    const manager = createSessionManager({
      dataDir: dir,
      spawnPty: () => new FakePty(),
    });

    expect(() => manager.readBuffer("missing")).toThrow("Unknown session id: missing");
    expect(() => manager.writeInput("missing", "echo nope")).toThrow("Unknown session id: missing");
    expect(() => manager.writeRaw("missing", "x")).toThrow("Unknown session id: missing");
    expect(() => manager.resize("missing", 80, 24)).toThrow("Unknown session id: missing");
    expect(() => manager.stop("missing")).toThrow("Unknown session id: missing");
  });
});
