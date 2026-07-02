import { loadItems } from "../store.js";
import { renderLine } from "../render.js";

export function run(args) {
  if (args.length) {
    console.error("Usage: todo list");
    process.exit(2);
  }
  for (const item of loadItems()) {
    console.log(renderLine(item));
  }
}
