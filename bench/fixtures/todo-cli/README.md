# todo-cli

Tiny task-list CLI used as the llm-fusion benchmark fixture.

## Usage

```
node src/cli.js add <title>
node src/cli.js list
node src/cli.js done <id>
node src/cli.js remove <id>
node src/cli.js stats
node src/cli.js clear
```

Items are stored in `.todo.json` in the working directory (override the path with the `TODO_FILE` environment variable). Output lines are produced by the `renderLine` helper in `src/render.js`.

## Tests

`npm test` runs the fast unit and CLI suites plus the slow integration suite. Set `SLOW_MS` to change the artificial latency in the slow suite (default 4000 ms per test).
