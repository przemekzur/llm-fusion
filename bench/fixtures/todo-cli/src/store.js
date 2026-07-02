import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function storePath() {
  return process.env.TODO_FILE || ".todo.json";
}

export function loadItems() {
  const path = storePath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text ? JSON.parse(text) : [];
}

export function saveItems(items) {
  writeFileSync(storePath(), JSON.stringify(items, null, 2) + "\n", "utf8");
}
