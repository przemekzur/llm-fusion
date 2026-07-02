import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const SLOW_MS = Number(process.env.SLOW_MS || 4000);

function makeRunner() {
  const dir = mkdtempSync(join(tmpdir(), "todo-cli-slow-"));
  const todoFile = join(dir, "todo.json");
  return (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, TODO_FILE: todoFile },
    });
}

test("full workflow keeps stats consistent", async () => {
  await sleep(SLOW_MS);
  const run = makeRunner();
  run(["add", "one"]);
  run(["add", "two"]);
  run(["add", "three"]);
  run(["done", "1"]);
  assert.equal(run(["stats"]).stdout.trim(), "1/3 done, 2 remaining");
});

test("remove keeps remaining in sync", async () => {
  await sleep(SLOW_MS);
  const run = makeRunner();
  run(["add", "one"]);
  run(["add", "two"]);
  run(["add", "three"]);
  run(["done", "1"]);
  run(["remove", "3"]);
  assert.equal(run(["stats"]).stdout.trim(), "1/2 done, 1 remaining");
});

test("clear resets the store", async () => {
  await sleep(SLOW_MS);
  const run = makeRunner();
  run(["add", "one"]);
  run(["clear"]);
  assert.equal(run(["stats"]).stdout.trim(), "0/0 done, 0 remaining");
});
