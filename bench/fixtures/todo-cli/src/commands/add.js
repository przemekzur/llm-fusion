import { fail } from "../errors.js";
import { loadItems, saveItems } from "../store.js";
import { addItem } from "../todo.js";
import { renderLine } from "../render.js";

export function run(args) {
  const title = args.join(" ");
  if (!title.trim()) fail("Usage: todo add <title>");
  const items = loadItems();
  addItem(items, title);
  saveItems(items);
  console.log(renderLine(items[items.length - 1]));
}
