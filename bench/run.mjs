#!/usr/bin/env node
// Benchmark runner for llm-fusion: seeds scenario workspaces and scores runs.
// Usage:
//   node bench/run.mjs list
//   node bench/run.mjs seed <scenarioId> <coordinator-solo|sidekick-solo|fusion>
//   node bench/run.mjs score <runDir> [--cost <usd>] [--model <label>] [--notes <text>]
//   node bench/run.mjs report

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsage, computeCost, fetchPrices, loadPrices, totalTokens } from "./usage.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(benchDir, "scenarios");
const fixturesDir = join(benchDir, "fixtures");
const runsDir = join(benchDir, "runs");

const ARMS = ["coordinator-solo", "sidekick-solo", "fusion"];
const SCOPE_IGNORE = [".todo.json", "node_modules/"];
const CHECK_ENV = { SLOW_MS: process.env.BENCH_SLOW_MS || "150" };

function loadScenarios() {
  return readdirSync(scenariosDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(scenariosDir, name), "utf8")));
}

function loadScenario(id) {
  const scenario = loadScenarios().find((item) => item.id === id || item.id.startsWith(id));
  if (!scenario) throw new Error(`Unknown scenario: ${id}. Try: node bench/run.mjs list`);
  return scenario;
}

function git(workspace, ...args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function seed(scenarioId, arm) {
  if (!ARMS.includes(arm)) throw new Error(`Arm must be one of: ${ARMS.join(", ")}`);
  const scenario = loadScenario(scenarioId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(runsDir, `${scenario.id}__${arm}__${stamp}`);
  const workspace = join(runDir, "workspace");
  mkdirSync(runDir, { recursive: true });
  cpSync(join(fixturesDir, scenario.fixture), workspace, { recursive: true });

  for (const mutation of scenario.mutations ?? []) {
    const path = join(workspace, mutation.file);
    const text = readFileSync(path, "utf8");
    if (!text.includes(mutation.find)) {
      throw new Error(`Mutation target not found in ${mutation.file}: ${mutation.find.slice(0, 60)}`);
    }
    writeFileSync(path, text.replace(mutation.find, mutation.replace), "utf8");
  }

  // Optional generated file fleets (content may be a string or array of lines;
  // {{NN}} expands to the zero-padded index when count > 1).
  for (const gen of scenario.generate ?? []) {
    const count = gen.count ?? 1;
    const template = Array.isArray(gen.content) ? gen.content.join("\n") + "\n" : gen.content;
    for (let i = 1; i <= count; i += 1) {
      const nn = String(i).padStart(2, "0");
      const target = join(workspace, gen.path.replaceAll("{{NN}}", nn));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, template.replaceAll("{{NN}}", nn), "utf8");
    }
  }

  git(workspace, "init", "--quiet");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "bench seed");

  const run = {
    scenarioId: scenario.id,
    arm,
    startedAt: new Date().toISOString(),
    workspace: relative(process.cwd(), workspace),
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");

  console.log(`Seeded ${scenario.id} [${arm}]`);
  console.log(`Workspace: ${run.workspace}`);
  console.log(`Timer started at ${run.startedAt} — hand the prompt to the agent now.`);
  console.log(`Timeout: ${scenario.timeoutMinutes} minutes`);
  console.log("\n--- PROMPT (identical for every arm) ---\n");
  console.log(scenario.prompt);
  console.log("\n--- After the agent declares done ---");
  console.log(`node bench/run.mjs score "${relative(process.cwd(), runDir)}" --cost <usd> --model "<models used>"`);
}

function runCheck(check, workspace) {
  if (check.type === "command") {
    const result = spawnSync(check.run, {
      cwd: workspace,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, ...CHECK_ENV },
    });
    const expected = check.expectExit ?? 0;
    return {
      pass: result.status === expected,
      evidence: result.status === expected ? `exit ${result.status}` : tail(result.stdout + result.stderr),
    };
  }

  if (check.type === "cli") {
    const result = spawnSync(process.execPath, ["src/cli.js", ...check.args], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, ...CHECK_ENV },
    });
    const expected = check.expectExit ?? 0;
    if (result.status !== expected) {
      return { pass: false, evidence: `exit ${result.status}, expected ${expected}: ${tail(result.stdout + result.stderr)}` };
    }
    if (check.parseJson) {
      try {
        JSON.parse(result.stdout);
      } catch {
        return { pass: false, evidence: `stdout is not valid JSON: ${tail(result.stdout)}` };
      }
    }
    return { pass: true, evidence: `exit ${result.status}` };
  }

  if (check.type === "present") {
    const path = join(workspace, check.file);
    if (!existsSync(path)) return { pass: false, evidence: `${check.file} missing` };
    const pass = new RegExp(check.pattern).test(readFileSync(path, "utf8"));
    return { pass, evidence: pass ? `found /${check.pattern}/ in ${check.file}` : `no /${check.pattern}/ in ${check.file}` };
  }

  if (check.type === "absent") {
    const rootDir = check.within ? join(workspace, check.within) : workspace;
    const regex = new RegExp(check.pattern);
    const offenders = walk(rootDir)
      .filter((path) => (check.extensions ?? []).some((ext) => path.endsWith(ext)))
      .filter((path) => regex.test(readFileSync(path, "utf8")))
      .map((path) => relative(workspace, path).replaceAll("\\", "/"));
    return {
      pass: offenders.length === 0,
      evidence: offenders.length ? `still matches in: ${offenders.join(", ")}` : `no matches for /${check.pattern}/`,
    };
  }

  if (check.type === "scope") {
    const changed = (git(workspace, "diff", "--name-only", "HEAD") + git(workspace, "ls-files", "--others", "--exclude-standard"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => !SCOPE_IGNORE.some((ignored) => path === ignored || path.startsWith(ignored)));
    const offenders = changed.filter((path) => !check.allowed.some((prefix) => path.startsWith(prefix) || path === prefix.replace(/\/$/, "")));
    return {
      pass: offenders.length === 0,
      evidence: offenders.length ? `out of scope: ${offenders.join(", ")}` : `${changed.length} changed paths, all in scope`,
    };
  }

  if (check.type === "maxDiffLines") {
    const total = git(workspace, "diff", "--numstat", "HEAD")
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((sum, line) => {
        const [added, removed] = line.split(/\s+/);
        return sum + (Number(added) || 0) + (Number(removed) || 0);
      }, 0);
    return { pass: total <= check.limit, evidence: `${total} diff lines (limit ${check.limit})` };
  }

  throw new Error(`Unknown check type: ${check.type}`);
}

function tail(text, chars = 300) {
  return (text || "").trim().slice(-chars).replace(/\s+/g, " ");
}

function score(runDirArg, flags) {
  const runDir = resolve(runDirArg);
  const runPath = join(runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const scenario = loadScenario(run.scenarioId);
  const workspace = join(runDir, "workspace");

  const blockers = (scenario.blockers ?? []).map((check) => ({ ...check, ...runCheck(check, workspace) }));
  const nonBlockers = (scenario.nonBlockers ?? []).map((check) => ({ ...check, ...runCheck(check, workspace) }));

  const blockersPassed = blockers.every((check) => check.pass);
  const totalWeight = nonBlockers.reduce((sum, check) => sum + (check.weight ?? 1), 0);
  const earnedWeight = nonBlockers.reduce((sum, check) => sum + (check.pass ? (check.weight ?? 1) : 0), 0);
  const quality = totalWeight ? Math.round((earnedWeight / totalWeight) * 100) : 100;

  const scoredAt = new Date().toISOString();
  const wallMinutes = Math.round(((Date.parse(scoredAt) - Date.parse(run.startedAt)) / 60000) * 10) / 10;

  const tokens = collectUsage({
    workspace,
    sinceMs: Date.parse(run.startedAt) - 30_000,
    untilMs: Date.parse(scoredAt) + 30_000,
  });
  const priceDoc = loadPrices();
  let cost;
  if (priceDoc && Object.keys(tokens).length) {
    cost = computeCost(tokens, priceDoc);
  } else if (!priceDoc) {
    console.warn("No bench/prices.json — run `node bench/run.mjs prices` to enable cost computation.");
  }

  Object.assign(run, {
    scoredAt,
    wallMinutes,
    pass: blockersPassed,
    // FrontierCode convention: failing any blocker zeroes the score.
    score: blockersPassed ? quality : 0,
    qualityIfPassed: quality,
    blockers: blockers.map(({ type, run: cmd, pattern, pass, evidence }) => ({ type, run: cmd, pattern, pass, evidence })),
    nonBlockers: nonBlockers.map(({ id, weight, pass, evidence }) => ({ id, weight, pass, evidence })),
    tokens,
    totalTokens: totalTokens(tokens),
    costBreakdown: cost?.perModel,
    unpricedModels: cost?.unpriced?.length ? cost.unpriced : undefined,
    computedCostUsd: cost?.total,
    costUsd: flags.cost !== undefined ? Number(flags.cost) : cost?.total ?? run.costUsd,
    costSource: flags.cost !== undefined ? "manual" : cost ? "computed" : run.costSource,
    model: (flags.model ?? run.model ?? Object.keys(tokens).join(" + ")) || undefined,
    notes: flags.notes ?? run.notes,
  });
  writeFileSync(runPath, JSON.stringify(run, null, 2) + "\n", "utf8");

  console.log(`\n${run.scenarioId} [${run.arm}]  pass=${run.pass}  score=${run.score}  wall=${run.wallMinutes}min  cost=$${run.costUsd ?? "?"} (${run.costSource ?? "none"})`);
  for (const check of blockers) console.log(`  BLOCKER ${check.pass ? "PASS" : "FAIL"}  ${check.type}  ${check.evidence}`);
  for (const check of nonBlockers) console.log(`  rubric  ${check.pass ? "pass" : "miss"}  ${check.id} (w${check.weight ?? 1})  ${check.evidence}`);
  for (const [model, entry] of Object.entries(run.costBreakdown ?? {})) {
    const t = entry.tokens;
    console.log(`  tokens  ${model} → ${entry.slug}  in=${t.input} cacheR=${t.cacheRead} cacheW=${t.cacheWrite} out=${t.output}  $${entry.costUsd}`);
  }
  if (run.unpricedModels) console.log(`  WARNING unpriced models (fix aliases in bench/prices.json): ${run.unpricedModels.join(", ")}`);
  if (!run.totalTokens) console.log("  tokens  none found for this workspace/window (agent ran elsewhere, or CLI writes no transcript)");
}

function report() {
  if (!existsSync(runsDir)) throw new Error("No runs yet.");
  const runs = readdirSync(runsDir)
    .map((name) => join(runsDir, name, "run.json"))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")))
    .filter((run) => run.scoredAt)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.arm.localeCompare(b.arm));

  const lines = [
    "# Benchmark results",
    "",
    `Generated ${new Date().toISOString()} from ${runs.length} scored runs.`,
    "",
    "| Scenario | Arm | Model | Pass | Score | Wall (min) | Tokens | Cost (USD) | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...runs.map(
      (run) =>
        `| ${run.scenarioId} | ${run.arm} | ${run.model ?? ""} | ${run.pass ? "✅" : "❌"} | ${run.score} | ${run.wallMinutes} | ${run.totalTokens ?? ""} | ${run.costUsd ?? ""} | ${run.notes ?? ""} |`,
    ),
    "",
  ];
  const outPath = join(benchDir, "RESULTS.md");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  console.log(`Written to ${relative(process.cwd(), outPath)}`);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "list") {
    for (const scenario of loadScenarios()) {
      console.log(`${scenario.id}  [${scenario.taxonomy}]  ${scenario.title}`);
    }
  } else if (command === "seed") {
    seed(rest[0], rest[1]);
  } else if (command === "score") {
    score(rest[0], parseFlags(rest.slice(1)));
  } else if (command === "report") {
    report();
  } else if (command === "prices") {
    const document = await fetchPrices();
    const count = Object.keys(document.prices).length;
    console.log(`Fetched ${count} model prices from OpenRouter → bench/prices.json`);
  } else {
    console.log("Usage: node bench/run.mjs <list|seed|score|report|prices>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
