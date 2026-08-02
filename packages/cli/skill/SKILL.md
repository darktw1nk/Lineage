---
name: evolving-prompts
description: Use when asked to improve, optimize, or evolve an LLM prompt with measurable quality — or to run the Lineage evolution CLI, author an evolution config, or interpret evolution results/fitness.
---

# Evolving Prompts (Lineage CLI)

## Overview

Lineage's genetic-algorithm engine evolves a seed prompt against a test set. You author a JSON config, run the CLI, and read the JSON result. Full config reference: `docs/cli.md`.

```bash
# Published package — anywhere, no checkout needed
npm i -g @voxor/lineage-cli
lineage --config cfg.json --db ./run.db --output results.json

# Inside this repo, running from source
npm run cli -- --config cfg.json --db ./run.db --output results.json
```

`lineage --init cfg.json` writes a runnable starter config, which is faster and less error-prone than authoring one from scratch. Both forms take identical flags; every example below uses `npm run cli --` and works with a bare `lineage` too.

Progress/logs → stderr. `--output` (and stdout) → pure JSON. Exit 0 = usable best prompt; exit 1 = none. A markdown report lands in `testoutputs/` beside the output file (`--report none` to skip it when only results.json matters; `--report <path>` to choose the destination).

Prefer `--output` over capturing stdout. If you do capture stdout, use `npm run --silent cli -- …` — plain `npm run` prepends its own banner to stdout and the captured file will not parse as JSON.

## Before the first run

1. **Pick catalogued models**: `npm run --silent cli -- --list-models --db ./throwaway.db` (the `--db` keeps even this read isolated from the shared desktop DB). Budget enforcement needs the model in the catalog; an uncatalogued ID is priced at **$0**, so every call costs nothing on paper and `budget` can never trip. Providers retire models — a 404 "model no longer available" means pick a newer one from the list.
2. **Keys**: env vars (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) win over stored keys. Cheap default when only Gemini is available: `gemini/gemini-2.5-flash-lite` for both `models` and `serviceModel`.
3. **Isolate**: always pass `--db ./throwaway.db` — the default DB is shared with the desktop app.

## Minimal config

```json
{
  "name": "Ticket triage",
  "seedPrompt": "Summarize the ticket.",
  "models": ["gemini/gemini-2.5-flash-lite"],
  "serviceModel": "gemini/gemini-2.5-flash-lite",
  "populationSize": 4, "generationSize": 4, "maxGenerations": 2,
  "budget": 0.02, "parallelLimit": 4,
  "testSet": [
    { "name": "refund", "mode": "llm_grade",
      "prompt": "<realistic input>", "expected": "<reference answer>" },
    { "name": "exact", "mode": "exact_match",
      "prompt": "<input>", "expected": "<only-correct output>" }
  ],
  "fitnessWeights": { "quality": 1.0, "cost": 0.1, "latency": 0.1 }
}
```

- `llm_grade` + `expected`: the judge receives `expected` as a reference and grades content AND format consistency with it. Encode format rules in `expected` itself; for very strict rubrics override `systemPrompts.llmGradingPrompt` (see `docs/cli.md`).
- `exact_match` needs the prompt to force terse output, or scores stay low on verbose models.
- Prompts for agents? Use mode `"json_schema"` (output must conform to a JSON Schema) and mode `"tool_call"` (`tools` + `expectedTool`: right function, right args) — both deterministic and judge-free, so they're cheap and noise-free. `argsMode` `"subset"` (default) ignores extra args; see docs/cli.md "Agent-builder test modes".
- `budget` is a hard stop. 4 nodes x 2 generations x 3 tests on flash-lite ≈ $0.003.
- `maxGenerations` counts from generation 0: `maxGenerations: 2` runs exactly generations 0 and 1.

## Getting improvement (not just runs)

- **Meta-prompting is the only failure-aware operator** — it reads test failures. When iterating on quality, set `"operators": { "mutationShare": 0.4, "metaPrompting": { "enabled": true, "share": 0.6 } }`. Blind mutations often hurt.
- **Iterate by reseeding**: take `best.prompt` from `results.json` as the next run's `seedPrompt`, optionally add `targetFitness` to stop early. Two small runs beat one big one.
- **`targetFitness` ceiling**: fitness is quality diluted by the other ENABLED weights. A weight whose normalization is missing (`cost` without `costNorm`, `latency` without `latencyNorm`) is disabled and dropped from the denominator, so `{quality: 1.0, cost: 0.1, latency: 0.1}` with no norms normalizes to 1.0 and the ceiling is a full 10 — the run logs a warning naming each disabled dimension. Compute the ceiling as `10 × qualityWeight / sum(ENABLED weights)`: with `costNorm` and `latencyNorm` actually configured, that same weight set caps at 10 × 1.0/1.2 ≈ 8.33 and `targetFitness: 9` would never trigger.
- **Multiple `models` entries** let evolution discover that a different model beats prompt rewording.
- **Trust the holdout number**: mark 1-2 tests `"holdout": true` (or set `holdoutShare`) and use `samplesPerTest: 2-3` with llm_grade when budget allows — the final `seed → champion` score on unseen tests (results `holdout` field) is the claim worth reporting, not the fitness on training tests.
- Budget matters? `--estimate --config cfg.json` prints the cost band + call count WITHOUT running (JSON on stdout). Treat `high` as the commit number; the startup banner shows the same estimate on real runs.
- Pass `--seed 42` (or `"seed"` in config) when comparing configurations — engine decisions reproduce exactly, so differences come from your change, not the shuffle. LLM outputs stay best-effort.
- Hanging provider or flaky network? Every call has a 120s abort timeout (retried, then the node fails and the run continues). Tune with `"callTimeoutMs"` — raise for slow reasoning models.
- Interrupted run (crash/Ctrl+C/timeout)? `--resume <runId>` continues from the checkpoint with spend intact — the run id is the `Run ID:` line printed to stderr at start, so capture stderr to a file for long runs. Pass the original `--config` too if the run used config-file keys or plugins; keep the same `--db`.
- Enable `"pairwise": { "enabled": true }` when llm_grade scores cluster (several candidates within ~0.5 of each other) — top contenders are re-ranked by head-to-head judging (both orders, position bias cancels); the champion is the playoff winner, not the noisiest 9.9. Playoff quality is judge-limited: use the strongest `serviceModel` you can afford. Judge calls count toward the budget (contender pairs × llm_grade tests × 2 orders per playoff).

## Reading results

`results.json`: `best.prompt` / `best.fitness` (0–10) / `best.model`, per-node `tests[].score` + `llmGradeReasoning` (judge's justification — read it to understand low scores), `totals.usd`, `stopReason` (`target` | `budget` | `exhausted` | …).

- `costBreakdown` splits actual spend by purpose (and `model:*` keys by model) — if LLM grading or playoffs dominate, cheapen `serviceModel`, not the candidates. With pairwise enabled: `playoffs` lists each generation's head-to-head ranking, ranked nodes carry `metrics.playoffRank`, and `best` is the last playoff's winner — which may have LOWER fitness than another node; that's the feature working, not a bug.

## Common mistakes

- Judging quality by fitness alone — fitness blends cost/latency weights; compare `quality` for prompt skill.
- Test prompts that are instructions instead of realistic inputs (the candidate prompt supplies the instructions; testSet prompts are the data).
- One test case — the winner overfits it. Use 3+, covering distinct behaviors.
