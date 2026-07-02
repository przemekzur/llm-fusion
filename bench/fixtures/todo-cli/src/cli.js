#!/usr/bin/env node
import { CliError } from "./errors.js";
import * as add from "./commands/add.js";
import * as list from "./commands/list.js";
import * as done from "./commands/done.js";
import * as remove from "./commands/remove.js";
import * as stats from "./commands/stats.js";
import * as clear from "./commands/clear.js";

const commands = { add, list, done, remove, stats, clear };

const [command, ...args] = process.argv.slice(2);
const module_ = commands[command];

if (!module_) {
  console.error(`Unknown command: ${command ?? "(none)"}. Try: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}

try {
  module_.run(args);
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  throw error;
}
