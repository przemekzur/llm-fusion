import { describe, expect, it, vi } from "vitest";
import { createFusionRouter } from "../src/server/fusionRouter.js";
import type { SessionManager } from "../src/server/sessionManager.js";

function makeFakeSessionManager() {
  const listeners = new Set<(sessionId: string, chunk: string) => void>();
  const sessionManager = {
    onOutput(cb: (sessionId: string, chunk: string) => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
  } as unknown as SessionManager;

  return {
    sessionManager,
    emit(sessionId: string, chunk: string) {
      for (const listener of listeners) listener(sessionId, chunk);
    },
  };
}

const DELEGATE = '@@FUSION:{"type":"delegate","title":"Run tests","instructions":"Run npm test"}';
const REPORT = '@@FUSION:{"type":"report","task":"task-1","status":"done","summary":"All green."}';

describe("fusion router", () => {
  it("dispatches a delegate exactly once despite TUI redraw repeats", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onDelegate = vi.fn();
    createFusionRouter({ sessionManager, onDelegate, onReport: vi.fn() });

    emit("s1", `output\n${DELEGATE}\nmore\n`);
    emit("s1", `redraw\n${DELEGATE}\n`);

    expect(onDelegate).toHaveBeenCalledTimes(1);
    expect(onDelegate).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "delegate", title: "Run tests", target: "sidekick" }),
    );
  });

  it("parses markers mid-line (TUIs paint output without real newlines)", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onDelegate = vi.fn();
    createFusionRouter({ sessionManager, onDelegate, onReport: vi.fn() });

    emit("s1", `Per routing rules, I'll delegate. ${DELEGATE} Reviewing next.\n`);

    expect(onDelegate).toHaveBeenCalledTimes(1);
  });

  it("ignores prompt-example markers registered via noteInjected", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onDelegate = vi.fn();
    const router = createFusionRouter({ sessionManager, onDelegate, onReport: vi.fn() });

    router.noteInjected("s1", `Output a line like ${DELEGATE} when you want to delegate.`);
    emit("s1", `Use a line like ${DELEGATE} when you delegate.\n`);

    expect(onDelegate).not.toHaveBeenCalled();
  });

  it("accepts markers preceded only by decorations and ANSI sequences", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onDelegate = vi.fn();
    createFusionRouter({ sessionManager, onDelegate, onReport: vi.fn() });

    emit("s1", `\n[32m  ● [0m${DELEGATE}\n`);

    expect(onDelegate).toHaveBeenCalledTimes(1);
  });

  it("filters the echo of injected text even when re-wrapped", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onReport = vi.fn();
    const router = createFusionRouter({ sessionManager, onDelegate: vi.fn(), onReport });

    router.noteInjected("s1", `Print one line like ${REPORT} when done.`);
    // Terminal wraps the echo so the marker lands at a line start.
    const wrapped = REPORT.replace('"status"', '\r\n"status"');
    emit("s1", `\n${wrapped}\n`);

    expect(onReport).not.toHaveBeenCalled();

    // A genuinely different report from the model still gets through.
    emit("s1", '\n@@FUSION:{"type":"report","task":"task-1","status":"done","summary":"Real result."}\n');
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith("s1", expect.objectContaining({ summary: "Real result." }));
  });

  it("assembles payloads split across output chunks", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onReport = vi.fn();
    createFusionRouter({ sessionManager, onDelegate: vi.fn(), onReport });

    emit("s1", '\n@@FUS');
    emit("s1", 'ION:{"type":"report","task":"task-9",');
    emit("s1", '"status":"blocked","summary":"Missing dependency."}\n');

    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ task: "task-9", status: "blocked" }),
    );
  });

  it("ignores schema-invalid payloads", () => {
    const { sessionManager, emit } = makeFakeSessionManager();
    const onDelegate = vi.fn();
    const onReport = vi.fn();
    createFusionRouter({ sessionManager, onDelegate, onReport });

    emit("s1", '\n@@FUSION:{"type":"report","task":"t","status":"done|blocked","summary":"x"}\n');
    emit("s1", '\n@@FUSION:{"type":"delegate","title":"No instructions"}\n');

    expect(onDelegate).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });
});
