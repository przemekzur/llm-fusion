import { z } from "zod";

export const FusionDelegateMessageSchema = z.object({
  type: z.literal("delegate"),
  title: z.string().min(1),
  target: z.literal("sidekick").default("sidekick"),
  instructions: z.string().min(1),
  allowedFiles: z.array(z.string().min(1)).optional(),
  readOnly: z.boolean().optional(),
});

export const FusionReportMessageSchema = z.object({
  type: z.literal("report"),
  task: z.string().min(1),
  status: z.enum(["done", "blocked"]),
  summary: z.string().min(1),
});

export const FusionMessageSchema = z.discriminatedUnion("type", [
  FusionDelegateMessageSchema,
  FusionReportMessageSchema,
]);

export type FusionDelegateMessage = z.infer<typeof FusionDelegateMessageSchema>;
export type FusionReportMessage = z.infer<typeof FusionReportMessageSchema>;
export type FusionMessage = z.infer<typeof FusionMessageSchema>;

export interface FusionParseWarning {
  line: number;
  raw: string;
  reason: string;
}

export interface FusionParseResult {
  messages: FusionDelegateMessage[];
  warnings: FusionParseWarning[];
}

const MARKER = "@@FUSION:";

export function parseFusionOutput(text: string): FusionParseResult {
  const messages: FusionDelegateMessage[] = [];
  const warnings: FusionParseWarning[] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(MARKER)) continue;

    const rawMessage = trimmed.slice(MARKER.length).trim();
    try {
      messages.push(FusionDelegateMessageSchema.parse(JSON.parse(rawMessage)));
    } catch (error) {
      warnings.push({
        line: index + 1,
        raw: rawMessage,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { messages, warnings };
}

export function parseFusionMessages(text: string): FusionDelegateMessage[] {
  const { messages } = parseFusionOutput(text);
  return messages;
}

/* ── Stream extraction (PTY output) ─────────────────────────────── */

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

export interface ExtractedFusionPayload {
  raw: string;
  normalized: string;
  message?: FusionMessage;
  reason?: string;
}

export interface FusionStreamResult {
  payloads: ExtractedFusionPayload[];
  remainder: string;
}

const MAX_PAYLOAD_LENGTH = 4000;
const REMAINDER_KEEP = 300;

function lineStartBefore(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1);
  return newline < 0 ? 0 : newline + 1;
}

// Interactive CLIs decorate output lines (bullets, box-drawing, padding), so a
// marker "starts a line" when nothing alphanumeric precedes it on that line.
// This is what keeps prose like `... a JSON object like {"type":...}` from the
// injected prompts from parsing as a real message.
function isLineStartMarker(text: string, markerIndex: number): boolean {
  const prefix = text.slice(lineStartBefore(text, markerIndex), markerIndex);
  return !/[a-zA-Z0-9]/.test(prefix);
}

function matchJsonObject(text: string, openIndex: number): { end: number } | "incomplete" | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    if (i - openIndex > MAX_PAYLOAD_LENGTH) return undefined;
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { end: i };
    }
  }

  return "incomplete";
}

function parseCandidate(raw: string): { message?: FusionMessage; reason?: string } {
  for (const candidate of [raw, raw.replace(/[\r\n]+/g, "")]) {
    try {
      const parsed = FusionMessageSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return { message: parsed.data };
      return { reason: parsed.error.issues[0]?.message ?? "schema mismatch" };
    } catch {
      // fall through to the newline-stripped candidate, then give up
    }
  }
  return { reason: "invalid JSON" };
}

export interface ExtractOptions {
  requireLineStart?: boolean;
}

export function extractFusionPayloads(text: string, options: ExtractOptions = {}): FusionStreamResult {
  const requireLineStart = options.requireLineStart ?? true;
  const payloads: ExtractedFusionPayload[] = [];
  let consumed = 0;
  let scanFrom = 0;
  let pendingStart: number | undefined;

  while (scanFrom < text.length) {
    const markerIndex = text.indexOf(MARKER, scanFrom);
    if (markerIndex < 0) break;

    if (requireLineStart && !isLineStartMarker(text, markerIndex)) {
      scanFrom = markerIndex + MARKER.length;
      consumed = Math.max(consumed, scanFrom);
      continue;
    }

    let jsonStart = markerIndex + MARKER.length;
    while (jsonStart < text.length && (text[jsonStart] === " " || text[jsonStart] === "\t")) jsonStart += 1;

    if (jsonStart >= text.length) {
      pendingStart = lineStartBefore(text, markerIndex);
      break;
    }

    if (text[jsonStart] !== "{") {
      scanFrom = markerIndex + MARKER.length;
      consumed = Math.max(consumed, scanFrom);
      continue;
    }

    const match = matchJsonObject(text, jsonStart);
    if (match === "incomplete") {
      pendingStart = lineStartBefore(text, markerIndex);
      break;
    }
    if (!match) {
      // oversized candidate: drop the marker and move on
      scanFrom = jsonStart + 1;
      consumed = Math.max(consumed, scanFrom);
      continue;
    }

    const raw = text.slice(jsonStart, match.end + 1);
    payloads.push({
      raw,
      normalized: raw.replace(/\s+/g, ""),
      ...parseCandidate(raw),
    });
    scanFrom = match.end + 1;
    consumed = scanFrom;
  }

  let remainderStart: number;
  if (pendingStart !== undefined) {
    remainderStart = Math.max(consumed, Math.min(pendingStart, text.length));
    if (text.length - remainderStart > MAX_PAYLOAD_LENGTH + REMAINDER_KEEP) {
      remainderStart = text.length - REMAINDER_KEEP;
    }
  } else {
    remainderStart = Math.max(consumed, text.length - REMAINDER_KEEP);
  }

  return { payloads, remainder: text.slice(remainderStart) };
}
