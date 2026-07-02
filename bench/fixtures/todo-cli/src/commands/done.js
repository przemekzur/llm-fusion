import { fail } from "../errors.js";
import { loadItems, saveItems } from "../store.js";
import { renderLine } from "../render.js";

export function run(args) {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) fail("Usage: todo done <id>");
  const items = loadItems();
  const item = items.find((entry) => entry.id === id);
  if (!item) fail(`No item #${id}`);
  item.done = true;
  saveItems(items);
  console.log(renderLine(item));
}
