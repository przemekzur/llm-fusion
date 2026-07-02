import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import * as pty from "node-pty";
import type { SessionRecord, SessionRole } from "../shared/types.js";

export interface PtyLike {
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode?: number; signal?: number }) => void): { dispose(): void };
}

export interface CreateSessionInput {
  role: SessionRole;
  label: string;
  command: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface SessionManager {
  createSession(input: CreateSessionInput): SessionRecord;
  listSessions(): SessionRecord[];
  getSession(id: string): SessionRecord | undefined;
  readBuffer(id: string): string;
  writeInput(id: string, input: string): void;
  writeRaw(id: string, input: string): void;
  resize(id: string, cols: number, rows: number): void;
  stop(id: string): void;
  onOutput(cb: (sessionId: string, chunk: string) => void): { dispose(): void };
}

export interface SessionManagerOptions {
  dataDir: string;
  spawnPty?: (input: CreateSessionInput) => PtyLike;
  scrollbackLimit?: number;
  typedInputDelayMs?: number;
}

interface ManagedSession {
  record: SessionRecord;
  pty: PtyLike;
  buffer: string;
}

const CHUNKED_INPUT_THRESHOLD = 160;
const TYPED_INPUT_DELAY_MS = 15;
const PASTE_SETTLE_MS = 400;

export interface PtySpawnCommand {
  file: string;
  args: string[];
  displayCommand: string;
}

function defaultShell(): string {
  return process.platform === "win32" ? "powershell.exe" : "bash";
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function hasPathSegment(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

function resolveWindowsExecutable(file: string): string {
  if (process.platform !== "win32" || hasPathSegment(file)) return file;
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const candidates = /\.[^\\/]+$/.test(file) ? [file] : [...extensions.map((ext) => `${file}${ext}`), file];

  for (const rawDir of (process.env.PATH || "").split(delimiter)) {
    if (!rawDir) continue;
    const dir = resolve(rawDir);
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }

  return file;
}

export function resolvePtySpawnCommand(command: string): PtySpawnCommand {
  const displayCommand = command.trim() || defaultShell();
  const [rawFile, ...args] = tokenizeCommand(displayCommand);
  const file = rawFile ? resolveWindowsExecutable(rawFile) : defaultShell();

  return { file, args, displayCommand };
}

export function buildPtyEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...source,
    NO_UPDATE_NOTIFIER: source.NO_UPDATE_NOTIFIER ?? "1",
    CODEX_DISABLE_UPDATE_CHECK: source.CODEX_DISABLE_UPDATE_CHECK ?? "1",
  };
}

function createFailedPty(error: unknown): PtyLike {
  const message = error instanceof Error ? error.message : String(error);
  return {
    write(): void {
      throw new Error(`Session failed to start: ${message}`);
    },
    resize(): void {
      throw new Error(`Session failed to start: ${message}`);
    },
    kill(): void {},
    onData(): { dispose(): void } {
      return { dispose() {} };
    },
    onExit(): { dispose(): void } {
      return { dispose() {} };
    },
  };
}

function spawnLocalPty(input: CreateSessionInput): PtyLike {
  const command = resolvePtySpawnCommand(input.command);
  return pty.spawn(command.file, command.args, {
    name: "xterm-color",
    cols: input.cols ?? 100,
    rows: input.rows ?? 30,
    cwd: input.cwd,
    env: buildPtyEnv(),
    ...(process.platform === "win32" ? { useConptyDll: true } : {}),
  });
}

function cloneSession(record: SessionRecord): SessionRecord {
  return { ...record };
}

function formatSubmittedInput(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
}

function submitInput(
  ptyProcess: PtyLike,
  input: string,
  typedDelayMs: number,
  isActive: () => boolean,
): void {
  const formatted = formatSubmittedInput(input);

  if (formatted.length <= CHUNKED_INPUT_THRESHOLD) {
    ptyProcess.write(`${formatted}\r\n`);
    return;
  }

  // Long input goes in as one bracketed paste: interactive TUIs (Claude,
  // Codex, PSReadLine) ingest it atomically, avoiding the O(n^2) input-box
  // redraws that per-character typing causes through ConPTY. The submit
  // Enter follows after a short settle so the TUI has consumed the paste.
  ptyProcess.write(`\x1b[200~${formatted}\x1b[201~`);
  // Two Enters: TUIs can swallow a keystroke while still ingesting the
  // paste; a second Enter on empty input is a no-op everywhere.
  const submit = (attempt: number) =>
    setTimeout(() => {
      if (!isActive()) return;
      ptyProcess.write("\r");
      if (attempt < 2) submit(attempt + 1);
    }, Math.max(typedDelayMs, PASTE_SETTLE_MS));
  submit(1);
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, ManagedSession>();
  const outputListeners = new Set<(sessionId: string, chunk: string) => void>();
  const logsDir = join(options.dataDir, "logs");
  const scrollbackLimit = options.scrollbackLimit ?? 300_000;
  const typedInputDelayMs = options.typedInputDelayMs ?? TYPED_INPUT_DELAY_MS;
  const spawnPty = options.spawnPty ?? spawnLocalPty;

  mkdirSync(logsDir, { recursive: true });

  function requireSession(id: string): ManagedSession {
    const session = sessions.get(id);
    if (!session) throw new Error(`Unknown session id: ${id}`);
    return session;
  }

  function touch(record: SessionRecord): void {
    record.lastActiveAt = new Date().toISOString();
  }

  function ensureActive(session: ManagedSession): void {
    if (session.record.status !== "active") {
      throw new Error(`Session is not active: ${session.record.id}`);
    }
  }

  return {
    createSession(input: CreateSessionInput): SessionRecord {
      const now = new Date().toISOString();
      const id = `session-${randomUUID()}`;
      const logPath = join(logsDir, `${id}.log`);
      const command = resolvePtySpawnCommand(input.command);
      const record: SessionRecord = {
        id,
        role: input.role,
        label: input.label,
        command: command.displayCommand,
        cwd: input.cwd,
        status: "active",
        createdAt: now,
        lastActiveAt: now,
        bufferTail: "",
        logPath,
      };
      let ptyProcess: PtyLike;
      let startError: unknown;

      try {
        ptyProcess = spawnPty(input);
      } catch (error) {
        startError = error;
        ptyProcess = createFailedPty(error);
        record.status = "failed";
        record.bufferTail = `Failed to start ${command.displayCommand}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        appendFileSync(logPath, `${record.bufferTail}\n`, "utf8");
      }

      const managed: ManagedSession = {
        record,
        pty: ptyProcess,
        buffer: record.bufferTail,
      };

      sessions.set(id, managed);

      if (startError) {
        return cloneSession(record);
      }

      ptyProcess.onData((chunk) => {
        managed.buffer = `${managed.buffer}${chunk}`;
        if (managed.buffer.length > scrollbackLimit) {
          managed.buffer = managed.buffer.slice(-scrollbackLimit);
        }
        managed.record.bufferTail = managed.buffer.slice(-8000);
        touch(managed.record);
        try {
          appendFileSync(logPath, chunk, "utf8");
        } catch {
          // A failed log write must not break the output stream.
        }
        for (const listener of outputListeners) {
          listener(id, chunk);
        }
      });

      ptyProcess.onExit(() => {
        if (managed.record.status === "active") {
          managed.record.status = "exited";
          touch(managed.record);
        }
      });

      return cloneSession(record);
    },

    listSessions(): SessionRecord[] {
      return Array.from(sessions.values(), (session) => cloneSession(session.record));
    },

    getSession(id: string): SessionRecord | undefined {
      const session = sessions.get(id);
      return session ? cloneSession(session.record) : undefined;
    },

    readBuffer(id: string): string {
      return requireSession(id).buffer;
    },

    writeInput(id: string, input: string): void {
      const session = requireSession(id);
      ensureActive(session);
      submitInput(session.pty, input, typedInputDelayMs, () => session.record.status === "active");
      touch(session.record);
    },

    writeRaw(id: string, input: string): void {
      const session = requireSession(id);
      ensureActive(session);
      session.pty.write(input);
      touch(session.record);
    },

    resize(id: string, cols: number, rows: number): void {
      const session = requireSession(id);
      ensureActive(session);
      session.pty.resize(cols, rows);
    },

    stop(id: string): void {
      const session = requireSession(id);
      session.record.status = "stopped";
      touch(session.record);
      session.pty.kill();
    },

    onOutput(cb: (sessionId: string, chunk: string) => void): { dispose(): void } {
      outputListeners.add(cb);
      return { dispose: () => outputListeners.delete(cb) };
    },
  };
}
