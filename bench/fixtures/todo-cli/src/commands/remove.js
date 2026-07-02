import { fail } from "../errors.js";
import { loadItems, saveItems } from "../store.js";
import { renderLine } from "../render.js";

export function run(args) {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) fail("Usage: todo remove <id>");
  const items = loadItems();
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) fail(`No item #${id}`);
  const [item] = items.splice(index, 1);
  saveItems(items);
  console.log(`removed ${renderLine(item)}`);
}
