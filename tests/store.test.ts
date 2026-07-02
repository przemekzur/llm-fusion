import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJsonStore } from "../src/server/jsonStore.js";
import { createLedgerStore } from "../src/server/ledgerStore.js";
import { SessionSchema, type SessionRecord } from "../src/shared/types.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("stores", () => {
  it("persists JSON arrays atomically", () => {
    const store = createJsonStore<SessionRecord[]>(join(dir, "sessions.json"), [], z.array(SessionSchema));
    const now = "2026-06-30T00:00:00.000Z";

    store.write([
      {
        id: "session-001",
        role: "coordinator",
        label: "Coordinator",
        command: "powershell.exe",
        cwd: dir,
        status: "active",
        createdAt: now,
        lastActiveAt: now,
        bufferTail: "",
        logPath: join(dir, "session-001.log"),
      },
    ]);

    expect(store.read()[0]?.id).toBe("session-001");
  });

  it("rejects persisted JSON that does not match the configured schema", () => {
    const filePath = join(dir, "sessions.json");
    writeFileSync(filePath, JSON.stringify([{ id: "session-001", role: "unknown" }]), "utf8");

    const store = createJsonStore<SessionRecord[]>(filePath, [], z.array(SessionSchema));

    expect(() => store.read()).toThrow();
  });

  it("appends and replays ledger events as JSONL", () => {
    const ledger = createLedgerStore(join(dir, "ledger.jsonl"));
    ledger.append({
      ts: "2026-06-30T00:00:00.000Z",
      missionId: "mission-001",
      type: "task.sent",
      actor: "operator",
      targetSessionId: "session-sidekick-001",
      taskId: "task-001",
      summary: "Sent task.",
      payload: {},
    });

    expect(ledger.list("mission-001")).toHaveLength(1);
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).toContain("task.sent");
  });
});
