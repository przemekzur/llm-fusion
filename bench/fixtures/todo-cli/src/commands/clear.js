import { saveItems } from "../store.js";

export function run(args) {
  if (args.length) {
    console.error("Usage: todo clear");
    process.exit(2);
  }
  saveItems([]);
  console.log("cleared");
}
