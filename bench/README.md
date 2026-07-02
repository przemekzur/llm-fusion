# llm-fusion benchmark

Measures whether the fusion approach ([Devin Fusion](https://cognition.com/blog/devin-fusion)) actually works here: does a smart coordinator delegating to cheaper sidekicks match solo-frontier quality at lower cost? Methodology is a scaled-down [FrontierCode](https://cognition.com/blog/frontier-code): blocker checks gate mergeability, weighted rubric items score quality, and failing any blocker zeroes the score.

## Arms

Every scenario runs three times with the **identical prompt**:

| Arm | Setup | What it establishes |
|---|---|---|
| `coordinator-solo` | One terminal, the smart model (e.g. Claude Opus high) does everything | Quality ceiling and cost ceiling |
| `sidekick-solo` | One terminal, the cheap model (e.g. Sonnet / Codex) does everything | Quality floor and cost floor |
| `fusion` | Full harness: coordinator + sidekicks, mission routing through the UI | The thing we are testing |

Fusion "works" on a scenario when: `score(fusion) ≈ score(coordinator-solo)` while `cost(fusion) < cost(coordinator-solo)`, and on judgment-heavy scenarios `score(fusion) > score(sidekick-solo)`.

## Scenarios

One shared fixture (`fixtures/todo-cli`, a zero-dependency Node CLI) hosts six scenarios spanning the Devin Fusion delegation taxonomy:

| Id | Taxonomy | Fusion hypothesis |
|---|---|---|
| s1-rename-sweep | mechanical | Delegable sweep, coordinator reviews the diff |
| s2-slow-verify-fix | test-heavy | Sidekick babysits the slow suite (biggest predicted saving) |
| s3-codebase-survey | broad-search | Sidekicks fan out, coordinator synthesizes |
| s4-scoped-feature | straightforward implementation | Unambiguous spec, delegable build + coordinator review |
| s5-judgment-trap | judgment-heavy | **Trap**: delegating the decision should hurt quality; coordinator must keep it |
| s6-regression-hunt | diagnosis | Localization delegable, minimal-fix choice is judgment |

## Protocol per run

1. **Seed** (starts the timer, prints the prompt):

   ```powershell
   node bench/run.mjs seed s1 fusion
   ```

2. **Run the agent(s)** in the printed workspace directory.
   - Solo arms: launch a single terminal in llm-fusion (or plain CLI) with the workspace as cwd, paste the prompt verbatim.
   - Fusion arm: set the workspace path in the harness, launch the trio, start a mission with the prompt, and route through the coordinator. Writes stay single-threaded: only one agent edits at a time.
   - Do not coach beyond the prompt. If the agent asks a question, answer only "use your best judgment".

3. **Score** as soon as the agent declares done:

   ```powershell
   node bench/run.mjs score bench/runs/<runDir> --notes "delegated tests to sidekick"
   ```

   Tokens and cost are computed automatically: the scorer reads Claude Code transcripts (`~/.claude/projects/<workspace-slug>/*.jsonl`) and Codex rollouts (`~/.codex/sessions/**/*.jsonl`) for sessions whose cwd matches the run workspace inside the run's time window, sums input/cache-read/cache-write/output tokens per model, and prices them with OpenRouter rates. Fetch rates once (and re-fetch whenever you like):

   ```powershell
   node bench/run.mjs prices
   ```

   Model-to-slug mappings are auto-resolved and persisted in `bench/prices.json` under `aliases`; edit that file if a model maps to the wrong slug. `--cost <usd>` still overrides the computed value (recorded as `costSource: manual`). Costs are OpenRouter list-price equivalents, not what your subscription actually bills — they are for comparing arms, not accounting.

4. **Aggregate**:

   ```powershell
   node bench/run.mjs report
   ```

   Writes `bench/RESULTS.md`.

## Metrics recorded per run

- `pass` — all blocker checks green (tests, behavior, required artifacts)
- `score` — weighted rubric percentage; 0 if any blocker fails
- `wallMinutes` — seed → score wall clock
- `tokens` / `totalTokens` — per-model input/cache-read/cache-write/output, harvested from CLI transcripts
- `costUsd` + `costBreakdown` — computed from OpenRouter rates (`costSource: computed`), or `--cost` override (`manual`)
- `model` / `notes` — configuration and delegation observations

Run each scenario+arm at least 3 times before trusting a comparison; single runs are noise.

## Known gaps

- Token harvesting requires the agents to run with the workspace as their cwd (the harness does this). Agents launched elsewhere won't be counted.
- The fusion arm's automatic loop (`@@FUSION` delegate → auto-routed task → sidekick report → relay to coordinator) requires routing mode `auto-lite`; use `suggested` if you want to approve each delegation during a run and note that in `--notes`.
