import { loadItems } from "../store.js";
import { stats } from "../todo.js";
import { renderStats } from "../render.js";

export function run() {
  console.log(renderStats(stats(loadItems())));
}
