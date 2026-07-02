// Token usage harvesting for the report endpoint: reads Claude Code
// transcripts and Codex rollouts for sessions whose cwd matches a workspace
// within a time window. Mirrors bench/usage.mjs (kept separate so the bench
// CLI stays dependency-free and the server stays inside src/).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface TokenBucket {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type ModelUsage = Record<string, TokenBucket>;

export interface PriceDoc {
  prices: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  aliases?: Record<string, string>;
}

function emptyBucket(): TokenBucket {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function addTo(models: ModelUsage, model: string, delta: TokenBucket): void {
  const bucket = models[model] ?? (models[model] = emptyBucket());
  bucket.input += delta.input;
  bucket.cacheRead += delta.cacheRead;
  bucket.cacheWrite += delta.cacheWrite;
  bucket.output += delta.output;
}

function parseLines(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

export function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

interface CollectInput {
  workspace: string;
  sinceMs: number;
  untilMs: number;
  home?: string;
}

function collectClaude({ workspace, sinceMs, untilMs, home = homedir() }: CollectInput, models: ModelUsage): void {
  const dir = join(home, ".claude", "projects", claudeProjectSlug(workspace));
  if (!existsSync(dir)) return;

  const workspaceResolved = resolve(workspace).toLowerCase();
  const perRequest = new Map<string, { model: string } & TokenBucket>();

  for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl"))) {
    const path = join(dir, name);
    if (statSync(path).mtimeMs < sinceMs) continue;

    for (const entry of parseLines(path) as Array<Record<string, any>>) {
      const usage = entry?.message?.usage;
      if (entry?.type !== "assistant" || !usage) continue;
      if (entry.cwd && resolve(entry.cwd).toLowerCase() !== workspaceResolved) continue;
      const ts = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;

      const key = entry.requestId || entry.message?.id || `${name}:${perRequest.size}`;
      perRequest.set(key, {
        model: entry.message?.model ?? "claude-unknown",
        input: usage.input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      });
    }
  }

  for (const request of perRequest.values()) {
    addTo(models, request.model, request);
  }
}

function collectCodex({ workspace, sinceMs, untilMs, home = homedir() }: CollectInput, models: ModelUsage): void {
  const root = join(home, ".codex", "sessions");
  if (!existsSync(root)) return;

  const workspaceResolved = resolve(workspace).toLowerCase();
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && statSync(path).mtimeMs >= sinceMs) files.push(path);
    }
  })(root);

  for (const path of files) {
    const entries = parseLines(path) as Array<Record<string, any>>;
    const meta = entries.find((entry) => entry?.type === "session_meta")?.payload;
    if (!meta?.cwd || resolve(meta.cwd).toLowerCase() !== workspaceResolved) continue;
    const startTs = Date.parse(meta.timestamp ?? "");
    if (!Number.isFinite(startTs) || startTs < sinceMs - 60_000 || startTs > untilMs) continue;

    const model = entries.filter((entry) => entry?.type === "turn_context").at(-1)?.payload?.model ?? "codex-unknown";
    const last = entries
      .filter((entry) => entry?.type === "event_msg" && entry?.payload?.type === "token_count")
      .map((entry) => entry.payload.info?.total_token_usage)
      .filter(Boolean)
      .at(-1);
    if (!last) continue;

    const cached = last.cached_input_tokens ?? 0;
    addTo(models, model, {
      input: Math.max(0, (last.input_tokens ?? 0) - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: last.output_tokens ?? 0,
    });
  }
}

export function collectUsage(input: CollectInput): ModelUsage {
  const models: ModelUsage = {};
  collectClaude(input, models);
  collectCodex(input, models);
  return models;
}

export function loadPriceDoc(root = process.cwd()): PriceDoc | undefined {
  const path = join(root, "bench", "prices.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PriceDoc;
  } catch {
    return undefined;
  }
}

function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .split("/")
    .at(-1)!
    .replace(/[^a-z0-9]/g, "");
}

function resolvePriceSlug(model: string, doc: PriceDoc): string | undefined {
  if (doc.aliases?.[model]) return doc.aliases[model];
  const target = normalizeModelId(model);
  let best: string | undefined;
  for (const slug of Object.keys(doc.prices)) {
    const normalized = normalizeModelId(slug);
    if (normalized === target) return slug;
    if (
      (normalized.startsWith(target) || target.startsWith(normalized)) &&
      (!best || normalizeModelId(best).length < normalized.length)
    ) {
      best = slug;
    }
  }
  return best;
}

export function computeCostUsd(usage: ModelUsage, doc: PriceDoc | undefined): number | undefined {
  if (!doc) return undefined;
  let total = 0;
  let priced = false;

  for (const [model, tokens] of Object.entries(usage)) {
    const slug = resolvePriceSlug(model, doc);
    const price = slug ? doc.prices[slug] : undefined;
    if (!price || (!price.input && !price.output)) continue;
    const cacheRead = price.cacheRead ?? price.input * 0.1;
    const cacheWrite = price.cacheWrite ?? price.input * 1.25;
    total +=
      tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * cacheRead +
      tokens.cacheWrite * cacheWrite;
    priced = true;
  }

  return priced ? Math.round(total * 10000) / 10000 : undefined;
}

export function totalTokens(usage: ModelUsage): number {
  return Object.values(usage).reduce(
    (sum, tokens) => sum + tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
    0,
  );
}
