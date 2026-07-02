// Token usage harvesting + pricing for benchmark runs.
//
// Sources:
//  - Claude Code transcripts: ~/.claude/projects/<cwd-slug>/*.jsonl
//    (per-request `message.usage` with cache read/write split, deduped by requestId)
//  - Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//    (cumulative `token_count` events; the last one per session wins)
//
// Pricing: OpenRouter public model list (https://openrouter.ai/api/v1/models),
// cached in bench/prices.json. Model ids from transcripts are fuzzy-matched to
// OpenRouter slugs; resolved aliases are persisted and can be edited by hand.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
export const PRICES_PATH = join(benchDir, "prices.json");

/* ── Collection ─────────────────────────────────────────────────── */

function emptyBucket() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function addTo(models, model, delta) {
  const bucket = models[model] ?? (models[model] = emptyBucket());
  bucket.input += delta.input;
  bucket.cacheRead += delta.cacheRead;
  bucket.cacheWrite += delta.cacheWrite;
  bucket.output += delta.output;
}

export function claudeProjectSlug(cwd) {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function parseLines(path) {
  const out = [];
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

export function collectClaudeUsage({ workspace, sinceMs, untilMs, home = homedir() }, models) {
  const dir = join(home, ".claude", "projects", claudeProjectSlug(workspace));
  if (!existsSync(dir)) return;

  const workspaceResolved = resolve(workspace).toLowerCase();
  const perRequest = new Map();

  for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl"))) {
    const path = join(dir, name);
    if (statSync(path).mtimeMs < sinceMs) continue;

    for (const entry of parseLines(path)) {
      const usage = entry?.message?.usage;
      if (entry?.type !== "assistant" || !usage) continue;
      if (entry.cwd && resolve(entry.cwd).toLowerCase() !== workspaceResolved) continue;
      const ts = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;

      const key = entry.requestId || entry.message.id || `${name}:${perRequest.size}`;
      perRequest.set(key, {
        model: entry.message.model ?? "claude-unknown",
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

export function collectCodexUsage({ workspace, sinceMs, untilMs, home = homedir() }, models) {
  const root = join(home, ".codex", "sessions");
  if (!existsSync(root)) return;

  const workspaceResolved = resolve(workspace).toLowerCase();
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && statSync(path).mtimeMs >= sinceMs) files.push(path);
    }
  })(root);

  for (const path of files) {
    const entries = parseLines(path);
    const meta = entries.find((entry) => entry?.type === "session_meta")?.payload;
    if (!meta?.cwd || resolve(meta.cwd).toLowerCase() !== workspaceResolved) continue;
    const startTs = Date.parse(meta.timestamp ?? entries[0]?.timestamp ?? "");
    if (!Number.isFinite(startTs) || startTs < sinceMs - 60_000 || startTs > untilMs) continue;

    const model =
      entries.filter((entry) => entry?.type === "turn_context").at(-1)?.payload?.model ?? "codex-unknown";
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

export function collectUsage(options) {
  const models = {};
  collectClaudeUsage(options, models);
  collectCodexUsage(options, models);
  return models;
}

/* ── Pricing ────────────────────────────────────────────────────── */

export async function fetchPrices() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`OpenRouter responded ${response.status}`);
  const body = await response.json();

  const prices = {};
  for (const model of body.data ?? []) {
    if (!/claude|gpt|codex|gemini/i.test(model.id)) continue;
    const pricing = model.pricing ?? {};
    prices[model.id] = {
      input: Number(pricing.prompt) || 0,
      output: Number(pricing.completion) || 0,
      cacheRead: Number(pricing.input_cache_read) || undefined,
      cacheWrite: Number(pricing.input_cache_write) || undefined,
    };
  }

  const existing = loadPrices();
  const document = {
    fetchedAt: new Date().toISOString(),
    source: "https://openrouter.ai/api/v1/models (USD per token)",
    aliases: existing?.aliases ?? {},
    prices,
  };
  writeFileSync(PRICES_PATH, JSON.stringify(document, null, 2) + "\n", "utf8");
  return document;
}

export function loadPrices() {
  if (!existsSync(PRICES_PATH)) return undefined;
  return JSON.parse(readFileSync(PRICES_PATH, "utf8"));
}

function normalizeModelId(id) {
  return id
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .split("/")
    .at(-1)
    .replace(/[^a-z0-9]/g, "");
}

export function resolvePriceSlug(model, priceDoc) {
  if (priceDoc.aliases?.[model]) return priceDoc.aliases[model];
  const target = normalizeModelId(model);
  const candidates = Object.keys(priceDoc.prices);

  let best;
  for (const slug of candidates) {
    const normalized = normalizeModelId(slug);
    if (normalized === target) return slug;
    if ((normalized.startsWith(target) || target.startsWith(normalized)) &&
        (!best || normalizeModelId(best).length < normalized.length)) {
      best = slug;
    }
  }
  return best;
}

export function computeCost(models, priceDoc) {
  const perModel = {};
  const unpriced = [];
  let total = 0;

  for (const [model, tokens] of Object.entries(models)) {
    const slug = resolvePriceSlug(model, priceDoc);
    const price = slug ? priceDoc.prices[slug] : undefined;
    if (!price || (!price.input && !price.output)) {
      unpriced.push(model);
      continue;
    }
    // Cache fallbacks follow Anthropic's ratios: reads 0.1x input, writes 1.25x.
    const cacheRead = price.cacheRead ?? price.input * 0.1;
    const cacheWrite = price.cacheWrite ?? price.input * 1.25;
    const cost =
      tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * cacheRead +
      tokens.cacheWrite * cacheWrite;
    perModel[model] = { slug, costUsd: round(cost), tokens };
    total += cost;

    if (!priceDoc.aliases) priceDoc.aliases = {};
    priceDoc.aliases[model] = slug;
  }

  writeFileSync(PRICES_PATH, JSON.stringify(priceDoc, null, 2) + "\n", "utf8");
  return { total: round(total), perModel, unpriced };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

export function totalTokens(models) {
  return Object.values(models).reduce(
    (sum, tokens) => sum + tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
    0,
  );
}
