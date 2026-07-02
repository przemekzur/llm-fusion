import test from "node:test";
import assert from "node:assert/strict";
import { addItem, stats } from "../src/todo.js";
import { renderLine } from "../src/render.js";

test("addItem appends trimmed items with incrementing ids", () => {
  const items = [];
  const first = addItem(items, "  buy milk ");
  const second = addItem(items, "call mom");
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(first.title, "buy milk");
  assert.equal(items.length, 2);
});

test("addItem rejects empty titles", () => {
  assert.throws(() => addItem([], "   "));
});

test("stats counts totals and completed items", () => {
  const items = [
    { id: 1, title: "a", done: true },
    { id: 2, title: "b", done: false },
  ];
  const result = stats(items);
  assert.equal(result.total, 2);
  assert.equal(result.done, 1);
});

test("renderLine marks completed items", () => {
  assert.equal(renderLine({ id: 3, title: "ship it", done: true }), "[x] #3 ship it");
  assert.equal(renderLine({ id: 4, title: "later", done: false }), "[ ] #4 later");
});
