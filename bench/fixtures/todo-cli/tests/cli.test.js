import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function makeRunner() {
  const dir = mkdtempSync(join(tmpdir(), "todo-cli-"));
  const todoFile = join(dir, "todo.json");
  return (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, TODO_FILE: todoFile },
    });
}

test("add echoes the newly added item", () => {
  const run = makeRunner();
  assert.equal(run(["add", "banana"]).stdout.trim(), "[ ] #1 banana");
  assert.equal(run(["add", "apple"]).stdout.trim(), "[ ] #2 apple");
});

test("list prints items in insertion order", () => {
  const run = makeRunner();
  run(["add", "banana"]);
  run(["add", "apple"]);
  assert.deepEqual(run(["list"]).stdout.trim().split("\n"), ["[ ] #1 banana", "[ ] #2 apple"]);
});

test("done marks an item complete", () => {
  const run = makeRunner();
  run(["add", "banana"]);
  assert.equal(run(["done", "1"]).stdout.trim(), "[x] #1 banana");
});

test("stats reports the done ratio", () => {
  const run = makeRunner();
  run(["add", "banana"]);
  run(["add", "apple"]);
  run(["done", "1"]);
  assert.ok(run(["stats"]).stdout.trim().startsWith("1/2 done"));
});

test("unknown commands exit with code 2", () => {
  const run = makeRunner();
  assert.equal(run(["nope"]).status, 2);
});
