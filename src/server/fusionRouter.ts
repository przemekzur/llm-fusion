import {
  extractFusionPayloads,
  stripAnsi,
  type FusionDelegateMessage,
  type FusionReportMessage,
} from "./fusionParser.js";
import type { SessionManager } from "./sessionManager.js";

export interface FusionRouterOptions {
  sessionManager: SessionManager;
  onDelegate: (sessionId: string, message: FusionDelegateMessage) => void;
  onReport: (sessionId: string, message: FusionReportMessage) => void;
}

export interface FusionRouter {
  /**
   * Register text the harness itself writes into a session (prompts, reports)
   * BEFORE writing it, so the terminal echo of any embedded @@FUSION example
   * is never routed as a real message.
   */
  noteInjected(sessionId: string, text: string): void;
  dispose(): void;
}

interface SessionScanState {
  tail: string;
  seen: Set<string>;
  injected: Set<string>;
}

const MAX_TAIL = 6000;

export function createFusionRouter(options: FusionRouterOptions): FusionRouter {
  const states = new Map<string, SessionScanState>();

  function stateFor(sessionId: string): SessionScanState {
    let state = states.get(sessionId);
    if (!state) {
      state = { tail: "", seen: new Set(), injected: new Set() };
      states.set(sessionId, state);
    }
    return state;
  }

  const subscription = options.sessionManager.onOutput((sessionId, chunk) => {
    const state = stateFor(sessionId);
    const text = state.tail + stripAnsi(chunk);
    // No line-start requirement: TUIs paint output with cursor moves, so a
    // real marker often lands mid-"line" after ANSI stripping. Injected-set
    // echo filtering plus dedup provide the false-positive protection.
    const { payloads, remainder } = extractFusionPayloads(text, { requireLineStart: false });
    state.tail = remainder.slice(-MAX_TAIL);

    for (const payload of payloads) {
      if (!payload.message) continue;
      if (state.injected.has(payload.normalized)) continue;
      if (state.seen.has(payload.normalized)) continue;
      state.seen.add(payload.normalized);

      try {
        if (payload.message.type === "delegate") {
          options.onDelegate(sessionId, payload.message);
        } else {
          options.onReport(sessionId, payload.message);
        }
      } catch {
        // Routing failures must never break the session output pump.
      }
    }
  });

  return {
    noteInjected(sessionId: string, text: string): void {
      const state = stateFor(sessionId);
      // No line-start requirement here: TUI re-wrapping can move an echoed
      // example to a line boundary, so match by payload content instead.
      const { payloads } = extractFusionPayloads(stripAnsi(text), { requireLineStart: false });
      for (const payload of payloads) {
        state.injected.add(payload.normalized);
      }
    },

    dispose(): void {
      subscription.dispose();
      states.clear();
    },
  };
}
