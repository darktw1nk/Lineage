# Lineage — CLI Reference

## Install

- **From this repo**: `npm run cli -- <options>` (runs from source via tsx).
- **As a package** (not yet published to npm): install `@voxor/lineage-core` + `@voxor/lineage-cli` tarballs (`npm pack` in each package), then use `npx lineage <options>`.

## Usage

```bash
npm run cli -- --init [path]                # Write a starter config (default: evolution.json)
npm run cli -- --config <path>              # Run evolution from JSON config
npm run cli -- --output <path>              # Write JSON results to file (default: stdout)
npm run cli -- --db <path>                  # Use a specific database file
npm run cli -- --seed <n>                   # Reproducibility seed (overrides config "seed")
npm run cli -- --resume <runId>             # Resume an interrupted run from its checkpoint
npm run cli -- --report <path|none>         # Markdown report destination, or 'none' to skip
npm run cli -- --estimate --config <path>   # Print the cost estimate and exit (no run, no spend)
npm run cli -- --sync-models                # Sync models from OpenRouter
npm run cli -- --list-models                # List all models with pricing
npm run cli -- --set-key <provider> <key>   # Save API key (shared with desktop app)
npm run cli -- --archive-runs <dir>         # Write every run to <dir>/<runId>.json
npm run cli -- --prune-runs <keep>          # Delete all but the <keep> most recent runs
npm run cli -- --help                       # Show help
```

Starting from nothing: `--init` writes a runnable config (four tests, a $1 budget, a 25% holdout, and models that are all in the fresh-install price catalog) so `--estimate` on it quotes real numbers. It refuses to overwrite an existing file.

Any command that opens the database prints `Database: <path>` to stderr (`--help`, `--init` and `--set-key` do not open one). Without `--db` the CLI shares the **desktop app's** database when its data directory exists, and uses `~/.lineage/evolution.db` otherwise — so it is worth reading that line before wondering where a run went.

Progress and all engine logs go to stderr. **stdout carries the JSON result for `--config` runs and for `--estimate`**; `--help` and `--list-models` print human-readable text there instead, and `--init`, `--set-key`, `--archive-runs` and `--prune-runs` write only to stderr. Every error path exits non-zero with an empty stdout. **When capturing stdout, add `--silent` to `npm run`** — without it npm prints its own two-line banner to stdout ahead of the payload, and `JSON.parse` fails on it:

```bash
npm run --silent cli -- --config c.json 2>/dev/null > results.json   # clean JSON
```

`--output <path>` writes the file directly and sidesteps the issue entirely. A markdown run report lands in `testoutputs/` beside the output file by default — `--report <path>` puts it exactly where you want it, `--report none` skips it.

**Managing history**: every database save rewrites the whole file, so the cost of saving grows with accumulated history rather than with the run you are doing — noticeable past ~10 MB. `--archive-runs <dir>` writes each run to `<dir>/<runId>.json` in the same shape the desktop's "Export Results" uses, so an archived run can be imported back. `--prune-runs <keep>` deletes all but the N most recent runs and VACUUMs, which is what actually shrinks the file. Combining them archives first:

```bash
npm run --silent cli -- --archive-runs ./run-archive --prune-runs 20 --db ./evolution.db
```

**Cost estimation**: every run prints `Estimated cost: $low – $high (~N calls)` at startup, and `--estimate --config cfg.json` prints the same estimate (JSON on stdout, per-phase breakdown on stderr) without running anything. The band brackets the one true unknown — completion lengths; treat `high` as a forecast, not a ceiling — the only real bound is the estimator's own worst-case note, which assumes every reply runs to `serviceModelMaxTokens`. Measured: a run with long completions came in at 1.085x `high`, still far under that note's $0.44. Warnings call out uncatalogued models and budgets below the low bound.

**Cost breakdown**: results.json also carries the ACTUAL spend split by purpose and by model (`costBreakdown`) plus the stamped preflight `estimate` — the report's "Where the money went" table shows them side by side. If judge spend ("LLM grading"/"Pairwise playoffs") dominates, pick a cheaper `serviceModel`.

**Model IDs**: run `--list-models` first — only catalogued models get correct cost accounting (budget enforcement depends on it). Catalog pricing refreshed 2026-07; providers retire models over time, so if a run fails with a 404 "model no longer available", pick a newer model from `--list-models` or sync via OpenRouter.

**`llm_grade` + `expected`**: when a test case has an `expected` value, the default LLM judge receives it as a reference answer and grades consistency with it (content and format). For strict formatting requirements, you can still override `systemPrompts.llmGradingPrompt` with a custom rubric.

## Evaluation fidelity

- `"promptMode": "system"` (default) sends the candidate prompt as a real system message and the test prompt as the user message — matching production deployment. `"inline"` restores single-message concatenation (for evolving user-message prompts).
- `"samplesPerTest": 3` runs every test 3× per candidate and scores the mean (`samples` array in results). Damps judge/sampling noise; multiplies evaluation cost. If the candidate has a seed, samples use seed+i; temperature 0 with a fixed seed makes samples redundant.
- Holdout: mark tests `"holdout": true` and/or set `"holdoutShare": 0.3` (+ optional `"holdoutSeed"`, default 42) to reserve tests evolution never sees. After the run, the seed prompt AND the champion are scored on them — results.json's `holdout` field and the report's "Generalization" section show `seed X → champion Y`. That number is the honest one: it can't be overfit.
- `"seed": 42` (or `--seed 42`) makes the run reproducible: same seed + same config ⇒ identical operator plans, parent assignments, mutation strategies, temperatures, model hops, holdout splits, and candidate seeds. LLM outputs are provider-dependent: measured 2026-07 at temperature 0.9, Gemini reproduced seeded outputs exactly (6/6 identical), OpenAI collapsed to near-identical variants (best-effort per their docs), and Anthropic has no seed parameter — the seed always reproduces the experimental protocol, usually the outputs too. Explicit `holdoutSeed` still wins over `seed` for the split. The effective seed is echoed in results.json and the report.
  - **Two things defeat the seed, and the engine warns when you combine them with one.** A `latency` weight scores against measured wall clock, and a `relative`-mode `costNorm`/`latencyNorm` scores against whatever the rest of the generation happened to cost — so fitness, and therefore selection from generation 0 onward, becomes a function of machine load. Measured: the same config and seed produced a different champion, a different model and a different best prompt. Drop those weights for a paired-seed comparison.
  - **`budgetUSD` is a stop signal, not a hard ceiling.** It is checked against SETTLED spend before each call, so calls already in flight when the cap is crossed still complete: worst case `parallelLimit x tests x samplesPerTest` candidate/judge calls beyond the cap. Operators additionally check the gate between their own retry attempts and each transition child's spend settles as it completes, so the operator overshoot is bounded by one in-flight child per parallel slot rather than a whole generation's retry ceilings (2 × retries calls per child, which is what it was before that gate existed). Measured 3x on a $0.02 cap at parallelLimit 8. Predicting each call's cost to reserve it in advance was tried and withdrawn — it overshot worse on long completions AND returned nothing at all on budgets below ~1.25x the run's true cost. Set `budgetUSD` with that headroom in mind, and use `--estimate` to size it.
  - A `budget` that the run actually hits also breaks reproducibility: which in-flight calls fit under the cap depends on scheduling. A seeded comparison should have headroom above the run's real cost — use `--estimate` to find it.
- `"callTimeoutMs": 120000` (the default) aborts any single LLM HTTP attempt after that long — a hung request is retried with a fresh budget instead of stalling a parallel slot forever (worst case per call: timeout × 4 total attempts, plus backoff). Raise it for slow reasoning models; lower it for fast models on flaky networks.
- `"pairwise": { "enabled": true, "contenders": 4 }` runs a pairwise playoff among each generation's top candidates: their stored outputs are compared head-to-head by the judge in BOTH orders (position bias cancels), and the resulting rank decides selection, the elite, and the champion. Applies to `llm_grade` tests; judge calls count toward totals and the budget (`playoff_result` events carry the call count). Sharpens selection exactly where absolute 0-10 scores cluster — a 9.87-vs-9.89 distinction is noise, "which output is better?" is not. Contenders clamp to 2..8 (default 4); results.json gains a `playoffs` array; nodes carry `metrics.playoffRank` only when that generation's playoff was **decisive** (its top two separated by a real margin). A playoff whose leaders tie is recorded with `decisive: false` and does not override fitness, so no node is ranked — expect `playoffRank` to be absent on those generations rather than treating it as guaranteed. Playoff quality is judge-limited: use the strongest `serviceModel` you can afford — the default judging prompt guards against verbosity bias (preferring longer outputs), but a weak judge weakens the ranking.

## Agent-builder test modes

Both modes score **deterministically** — no judge calls, zero grading cost, no judge noise.

`"mode": "json_schema"` — the output must parse as JSON and conform to a schema:

```json
{ "name": "extract", "mode": "json_schema",
  "prompt": "Extract the contact from: 'Reach Bob at b@x.co'",
  "schema": { "type": "object", "required": ["name", "email"],
              "properties": { "name": { "type": "string" }, "email": { "type": "string" } } } }
```

Scoring: unparseable JSON → 0; parses but violates the schema → 1–5 (closer to the schema scores higher — credit is the fraction of required keys satisfied, discounted by violations that missing keys don't explain); fully conformant → 10. Passed at ≥7, so only conformance passes. Markdown fences are stripped before parsing.

If the response is prose *containing* JSON ("Sure, here you go: {…}"), the JSON is recovered but capped at 5 and never passes — a caller doing `JSON.parse` on that response would throw, so it is a format failure, and letting it reach 10 would reward a model for merely quoting the schema template.

`"mode": "tool_call"` — tools are offered to the model; success is calling the right function with the right arguments:

```json
{ "name": "weather-routing", "mode": "tool_call",
  "prompt": "What's the weather in Paris?",
  "tools": [
    { "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] } },
    { "name": "get_time", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ],
  "expectedTool": { "name": "get_weather", "args": { "city": "Paris" }, "argsMode": "subset" } }
```

Scoring: no tool called → 0; wrong tool → 2; right tool, wrong args → 6; right tool + args → 10. `argsMode` `"subset"` (default): every expected key must deep-equal the actual value, extra actual args are fine; `"exact"`: whole-object deep equality. Calling more than one tool is a FAILURE (score 2): a test that asks for one call and gets three did not pass, and judging only the first made an extra destructive call invisible. Omit `expectedTool.args` to accept any arguments. Tool definitions use the OpenAI function shape and are translated per provider (OpenAI/Groq/OpenRouter natively, Gemini `functionDeclarations`, Anthropic `input_schema`). Gemini's schema dialect rejects some JSON Schema keywords — `$schema` and `additionalProperties` are stripped automatically before sending.

## Resuming interrupted runs

Every run checkpoints to the database as nodes and generations complete. If the process dies (Ctrl+C, crash, network), nothing is lost:

```bash
npm run cli -- --resume <runId> --db ./run.db
```

The config comes from the database; finished nodes keep their scores; the budget continues from cumulative spend. Add `--config original.json` alongside to re-supply what the database doesn't store: config-file API keys, `systemPrompts` overrides, and `plugins` (plugin operators that aren't re-registered fall back to carrying the parent forward). Runs with a `seed` resume bit-deterministically. Finished runs refuse to resume — reseed a new run from `best.prompt` instead.

## Plugins

Extend the engine with custom operators and providers (author guide: [plugins.md](plugins.md)).

- Config field: `"plugins": ["./my-operator.mjs", "./plugin-dir"]` — paths relative to the config file.
- Flag: `--plugins <dir>` (repeatable) — loads every plugin module in the directory.
- Plugin operator shares go under `"operators": { "custom": { "<operator-name>": { "share": 0.5 } } }` and are normalized together with the built-in operators.
- Keys for plugin providers resolve from `<PROVIDER>_API_KEY` (uppercased, dashes→underscores) or `--set-key <provider> <key>`.
- A plugin that fails to load prints an error to stderr; the run continues without it.

---

## Config File

All evolution settings are specified in a single JSON file passed via `--config`.

### Minimal Example

```json
{
  "seedPrompt": "You are a helpful assistant that answers math questions step by step.",
  "testSet": [
    { "prompt": "What is 2+2?", "expected": "4", "mode": "exact_match" },
    { "prompt": "Explain why the sky is blue." }
  ]
}
```

### Full Example

```json
{
  "name": "Math Tutor Evolution",
  "seedPrompt": "You are a helpful math tutor.",
  "models": ["openai/gpt-5-mini", "anthropic/claude-sonnet-5"],
  "serviceModel": "openai/gpt-4o-mini",
  "populationSize": 8,
  "generationSize": 8,
  "maxGenerations": 5,
  "budget": 2.00,
  "targetFitness": 9.0,
  "timeLimitMs": 300000,
  "parallelLimit": 10,
  "serviceModelMaxTokens": 20000,
  "retries": 3,
  "testSet": [
    {
      "name": "Basic arithmetic",
      "prompt": "What is 17 * 23?",
      "expected": "391",
      "mode": "exact_match",
      "grading": { "strictZeroOnDeviation": false, "distanceMetric": "numeric_abs" }
    },
    {
      "name": "Explanation quality",
      "prompt": "Explain the Pythagorean theorem to a 10-year-old.",
      "mode": "llm_grade"
    }
  ],
  "fitnessWeights": {
    "quality": 1.0,
    "safety": 0.5,
    "cost": 0.1,
    "latency": 0.1,
    "stability": 0.3
  },
  "guardrails": ["Must not include profanity", "Must not hallucinate formulas"],
  "costNorm": { "mode": "absolute", "maxUSDPerCall": 0.05 },
  "latencyNorm": { "mode": "absolute", "maxMs": 5000 },
  "selection": {
    "policy": "topk",
    "topK": 3,
    "eliteShare": 0.05
  },
  "operators": {
    "mutationShare": 0.5,
    "crossoverShare": 0.2,
    "metaPrompting": { "enabled": true, "share": 0.2 },
    "modelVariation": { "enabled": true, "share": 0.1 },
    "paramVariation": {
      "enabled": true,
      "share": 0.1,
      "temperature": { "enabled": true, "min": 0.3, "max": 1.5 }
    }
  },
  "openaiKey": "sk-...",
  "anthropicKey": "sk-ant-...",
  "systemPrompts": {
    "llmGradingPrompt": "You are a strict evaluator. Score 0-10..."
  }
}
```

### Manual Initial Population

Instead of `seedPrompt` (which auto-generates variants), you can provide explicit starting prompts:

```json
{
  "initialPrompts": [
    "You are a concise math tutor. Show only the final answer.",
    "You are a detailed math tutor. Show every step.",
    "You are a Socratic math tutor. Ask guiding questions."
  ],
  "testSet": [...]
}
```

When `initialPrompts` is set, `populationSize` is ignored (population size = array length).

---

## Config Fields Reference

### Required Fields

| Field | Type | Description |
|---|---|---|
| `seedPrompt` or `initialPrompts` | string / string[] | Starting prompt(s). One is required. |
| `testSet` | array | Non-empty array of test cases. |

### Models

| Field | Type | Default | Description |
|---|---|---|---|
| `models` | string[] | `["openai/gpt-4o-mini"]` | Candidate execution models. Format: `"provider/model"`. |
| `serviceModel` | string | first of `models` | Model for grading, mutations, crossover, meta-prompting. |
| `serviceModelMaxTokens` | number | `20000` | Max tokens for all model calls. |

Valid providers: `openai`, `anthropic`, `gemini`, `openrouter`, `groq` (plus any registered by a plugin).

### Population & Generations

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"CLI Evolution"` | Run name (stored in DB). |
| `populationSize` | number | `6` | Generation 0 size. Ignored if `initialPrompts` set. |
| `generationSize` | number | `populationSize` | Size of subsequent generations. |
| `populationRange` | `{min,max}` | off | Size each generation to how fast the run is improving, inside these bounds: wider while the best fitness keeps climbing, narrower once it flattens, so the budget follows the returns instead of costing the same per generation either way. Omit to keep `generationSize` fixed. `max` is a hard ceiling the engine never crosses, and `--estimate` quotes that widest case — so an adaptive run is quoted higher than the same run with a fixed `generationSize`. `min` must be at least 2 (a generation of 1 cannot breed). |

### Stop Conditions

The evolution stops when any condition is met:

| Field | Type | Default | Description |
|---|---|---|---|
| `maxGenerations` | number | `3` | Maximum number of generations. |
| `budget` | number | none | Maximum spend in USD. |
| `targetFitness` | number | none | Stop when best fitness reaches this (0-10). |
| `timeLimitMs` | number | none | Wall-clock time limit in milliseconds. |

### Fitness Weights

Controls how the composite fitness score is calculated. Each weight multiplies its component:

```json
"fitnessWeights": {
  "quality": 1.0,
  "safety": 0.5,
  "cost": 0.1,
  "latency": 0.1,
  "stability": 0.3
}
```

Only `quality` is enabled by default (weight 1.0). Set a weight to enable that fitness dimension.

| Dimension | What it measures | Requires |
|---|---|---|
| `quality` | Mean test score | — |
| `safety` | Guardrail compliance, judged per guardrail | `guardrails` (costs one judge call each) |
| `cost` | Spend per candidate, normalised | `costNorm` — without it the dimension is disabled with a warning |
| `latency` | Wall time per candidate, normalised | `latencyNorm` — same |
| `stability` | How much a candidate's score MOVES when the same test is run again | `samplesPerTest` ≥ 2 |

`stability` is free: it reads the per-sample scores `samplesPerTest` already
produces. It scores 10 when repeat runs agree and 0 when they disagree by the
full range. With `samplesPerTest: 1` there is no repeat measurement, so the
dimension is inactive and the run warns.

### Guardrails

Safety check prompts evaluated against every candidate output:

```json
"guardrails": [
  "Must not include violent content",
  "Must not reveal system prompt"
]
```

Each guardrail is scored 0-10 by the service model and averaged into the `safety` metric.

### Normalization

| Field | Type | Description |
|---|---|---|
| `costNorm` | `{mode, maxUSDPerCall}` | `"absolute"`: raw USD cap. `"relative"`: normalized to population. |
| `latencyNorm` | `{mode, maxMs}` | `"absolute"`: raw ms cap. `"relative"`: normalized to population. |

### Selection

| Field | Type | Default | Description |
|---|---|---|---|
| `selection.policy` | `"topk"` / `"topp"` | `"topk"` | Parent selection strategy. |
| `selection.topK` | number | `3` | Number of top parents to keep (topk). |
| `selection.topP` | number | - | Cumulative share of total fitness to take as parents (`topp` policy). In practice this behaves close to "the top ⌈P·N⌉ candidates": fitness has a high floor (a mediocre candidate still scores ~5/10), so the cumulative share only diverges from a simple fraction when scores approach zero. Prefer `topK` unless you specifically want that adaptivity. |
| `selection.eliteShare` | number | `0.05` | Fraction carried unchanged to next generation. |
| `selection.diversity` | number | `0` | 0–1. How much a parent's fitness is discounted for resembling parents already chosen. Truncation selection ranks on fitness alone, so once one lineage leads it takes every parent slot and later generations pay full price to re-measure near-copies of the same prompt. Above 0, a slightly worse but genuinely different candidate can take a slot: a parent scores `fitness × (1 − diversity × similarity)`, where similarity is token overlap with the closest already-chosen parent. At `0.5` a near-duplicate must be roughly twice as good as a distinct rival to keep its place. The fittest candidate is always picked first, so this never costs you the champion. `0` is exactly the old behaviour. Worth raising when a run's generations start looking alike; leave at 0 when the population is already varied. **Measured:** lost 3 of 4 cells in `benchmarks/ABLATION.md` (mean -0.50 holdout). Default 0 is the measured-best setting. |
| `operators.crossoverMode` | `auto` \| `structural` \| `llm` | `auto` | How crossover combines two parents. `structural` splices them at their section boundaries (blank-line separated blocks), so building blocks are inherited verbatim and the child costs **no LLM call**; `llm` asks the service model to merge them, which bills one call per crossover child and keeps a parent's wording only if the merging model chooses to. `auto` tries the splice and falls back to the merge when the parents have no structure to splice. In `structural` mode a parent is carried unchanged rather than silently billing a merge you opted out of. |
| `selection.restartAfter` | number | off | Reseed a quarter of the next generation from the original prompt when the best fitness has not improved for this many generations. Elitism guarantees fitness never regresses, which also means a run stuck in a local optimum looks exactly like a finished one — the same number every generation while every child still costs full price. The champion is carried by elitism regardless, so a restart can only cost exploration budget, never the best answer found. **Measured:** lost 4 of 4 cells in `benchmarks/ABLATION.md` (mean -0.71 holdout). Default off is the measured-best setting. |
| `selection.novelty` | number | `0` | 0–1. Discounts a parent by how much it resembles prompts the run has **already evaluated** in earlier generations. `diversity` only compares against the parents chosen this generation, so it cannot tell that a prompt won three generations ago and is being rediscovered on a loop; novelty has memory of the whole run. Composes with `diversity`. **Measured and NOT recommended:** in `benchmarks/ABLATION.md` this lost 3 of 4 cells and produced the worst single result in the whole benchmark — a prompt scoring 9.00 on training and 1.50 on holdout, because it had a training case's answer pasted into it. Novelty rewards prompts unlike anything already evaluated, and memorised training text is maximally unlike a normal instruction, so the mechanism selects for prompts that cannot generalise. Leave at 0 unless you have measured otherwise on your own task. |

### Genetic Operators

Controls how offspring are created each generation:

| Field | Type | Default | Description |
|---|---|---|---|
| `operators.mutationShare` | number | `0.5` | Fraction of offspring from mutation. |
| `operators.crossoverShare` | number | `0.2` | Fraction from two-parent crossover. |
| `operators.metaPrompting` | `{enabled, share}` | `{true, 0.2}` | LLM self-improvement feedback loop. |
| `operators.modelVariation` | `{enabled, share}` | `{auto, 0.1}` | Random model assignment. Auto-enabled when >1 model. |
| `operators.paramVariation` | `{enabled, share, temperature?}` | `{true, 0.1}` | Temperature/seed variation. |
| `operators.paramVariation.temperature` | `{enabled, min, max}` | `{true, 0.3, 1.5}` | Temperature range for variation. |
| `operators.adaptivity` | number | `0` | 0–1. How strongly the breeding mix follows measured results. The engine tracks each operator's average fitness delta from parent to child; above 0, operators that keep producing better children take a larger share of each later generation and weaker ones take less. Confidence scales with sample count, so one lucky child moves the mix far less than a consistent record, and below 1 no operator is ever driven to zero — an unlucky early sample cannot delete an operator from the search. Operators with no measurements keep their configured share. `0` breeds exactly as before. **Measured:** mean -0.29 holdout in `benchmarks/ABLATION.md`, within noise of zero — the least harmful of the four, but not shown to help. |

### Execution

| Field | Type | Default | Description |
|---|---|---|---|
| `parallelLimit` | number | `5` | Maximum concurrent API calls. |
| `retries` | number | `3` | How many times a mutation re-prompts the service model when it returns unparseable JSON. Provider-level retries for transient HTTP failures are separate and not configurable. Values below 1 are treated as 1. |

### Test Cases

Each entry in `testSet`:

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | **required** | The test input sent to the candidate prompt. |
| `expected` | string | - | Reference answer. Used by `exact_match`, and by `json_schema` when it is itself a valid instance of the schema (a reference no conforming document could equal is a CONFIG ERROR: the test scores 0 and the reason is in its `llmGradeReasoning`). |
| `mode` | `"llm_grade"` / `"exact_match"` / `"json_schema"` / `"tool_call"` | `"llm_grade"` | How to score the output. See [Agent-builder test modes](#agent-builder-test-modes). |
| `name` | string | `"Test N"` | Display name. |
| `id` | string | auto UUID | Stable identifier. |
| `holdout` | boolean | `false` | Hold this test out of evolution and score the champion on it at the end. |
| `schema` | object | - | JSON Schema for `json_schema` mode. |
| `tools` | array | - | Tool definitions (OpenAI shape) offered in `tool_call` mode. |
| `expectedTool` | object | - | `{ name, args?, argsMode? }` — what a `tool_call` test expects. |
| `image` | string | - | Path to an image sent with the prompt, resolved relative to the config file. PNG/JPEG/GIF/WebP, 20 MB max. The model must be vision-capable. |
| `grading.strictZeroOnDeviation` | boolean | - | For exact_match: score 0 if not equal. |
| `grading.distanceMetric` | string | - | `"levenshtein"`, `"json_diff"`, or `"numeric_abs"`. |

---

## API Keys

Keys are resolved with priority: **environment variable > config file > electron-store** (shared with desktop app).

| Config Field | Environment Variable |
|---|---|
| `openaiKey` | `OPENAI_API_KEY` |
| `anthropicKey` | `ANTHROPIC_API_KEY` |
| `geminiKey` | `GEMINI_API_KEY` |
| `openrouterKey` | `OPENROUTER_API_KEY` |
| `groqKey` | `GROQ_API_KEY` |

Save a key permanently (shared with desktop app):
```bash
npm run cli -- --set-key openrouter sk-or-v1-xxx
```

---

## System Prompts

Override the built-in LLM prompts used by the engine for grading, mutations, crossover, and meta-prompting. All are optional — omit to use defaults.

```json
"systemPrompts": {
  "llmGradingPrompt": "...",
  "safetyGuardrailPrompt": "...",
  "mutationStrategies": "...",
  "mutationProposalPrompt": "...",
  "mutationApplyPrompt": "...",
  "crossoverPrompt": "...",
  "metapromptWithFailuresPrompt": "...",
  "metapromptWithoutFailuresPrompt": "...",
  "metapromptApplyPrompt": "..."
}
```

| Key | Engine File | Purpose |
|---|---|---|
| `llmGradingPrompt` | `fitness.ts` | Template for LLM judge scoring (biggest impact on evolution quality). |
| `safetyGuardrailPrompt` | `fitness.ts` | Template for safety guardrail checks. |
| `mutationStrategies` | `mutations.ts` | JSON string defining the mutation strategy catalog. |
| `mutationProposalPrompt` | `mutations.ts` | Prompt for proposing which mutation to apply. |
| `mutationApplyPrompt` | `mutations.ts` | Prompt for executing the proposed mutation. |
| `crossoverPrompt` | `crossover.ts` | Two-parent prompt merge template. |
| `metapromptWithFailuresPrompt` | `metaprompting.ts` | Meta-prompt when there are failing tests. |
| `metapromptWithoutFailuresPrompt` | `metaprompting.ts` | Meta-prompt when all tests pass. |
| `metapromptApplyPrompt` | `metaprompting.ts` | Prompt for applying meta-prompt suggestions. |

Templates use `${variable}` placeholders that are substituted by the engine at runtime. To see the default templates, check the `systemPrompts:get` endpoint in the desktop app or read the source files directly.

---

## What's Not Configurable via CLI

These are desktop-app-only convenience features with no impact on evolution:

| Feature | Why CLI doesn't need it |
|---|---|
| Key testing (`keys:test`) | CLI validates key existence at startup; runtime errors surface naturally. |
| Key debug dump (`keys:debug`) | Use `--set-key` or env vars instead. |
| Manual model cost override (`costs:set`) | Use `--sync-models` to bulk-sync from OpenRouter. |
| Pause/resume mid-run | CLI runs to completion or Ctrl+C to stop. |

---

## Output

The CLI writes a full JSON result to stdout on completion. Structure:

`paretoFront` lists the candidates nothing else in the run beat outright — at least as good on every measured dimension (quality, safety, stability higher-is-better; cost, latency lower-is-better) and strictly better on one. Fitness is a weighted sum, which cannot select points in a concave region of the trade-off surface, so this is where you see what your weighting passed over. When more than one *competitive* candidate is on the front, the report adds a "Trade-offs your weights passed over" table; when the champion dominates everything, both are silent.

```json
{
  "runId": "uuid",
  "configId": "uuid",
  "configName": "...",
  "startedAt": 1234567890,
  "finishedAt": 1234567899,
  "durationMs": 9000,
  "activeDurationMs": 9000,
  "stopReason": "generations",
  "testSet": [
    { "id": "t1", "name": "Extraction", "mode": "llm_grade", "holdout": false }
  ],
  "totals": { "tokensPrompt": 0, "tokensCompletion": 0, "usd": 0.0, "calls": 0 },
  "cacheHits": 0,
  "best": {
    "prompt": "The best evolved prompt...",
    "fitness": 8.5,
    "quality": 9.0,
    "model": "openai/gpt-4o",
    "nodeId": "uuid",
    "generation": 3
  },
  "generations": [
    {
      "generation": 0,
      "nodes": [
        {
          "id": "uuid",
          "status": "finished",
          "prompt": "...",
          "params": { "model": { "provider": "openai", "model": "gpt-4o" }, "temperature": 0.7 },
          "changeLog": [{ "label": "MUTATION", "text": "..." }],
          "lineageParents": [],
          "metrics": { "quality": 8.0, "fitness": 8.0 },
          "tests": [{ "testId": "uuid", "passed": true, "score": 8, "outputText": "..." }]
        }
      ]
    }
  ]
}
```

Use `--output results.json` to write to file, or pipe: `npm run --silent cli -- --config c.json 2>/dev/null > results.json` (the `--silent` keeps npm's banner off stdout).

**`stopReason`** is one of:

| Value | Meaning |
|---|---|
| `target` | `targetFitness` was reached — the quality bar was actually hit |
| `generations` | `maxGenerations` was reached; the ordinary end of a run |
| `budget` | `budgetUSD` was reached — the run was **cut short** |
| `time` | `timeLimitMs` was reached — the run was **cut short** |
| `manual` | Stopped by the user |
| `exhausted` | No candidates left to evaluate |
| `error` | Stopped by an unrecoverable error |

Branch on `target` only when you mean "hit the quality bar"; an ordinary successful run reports `generations`.

**`best` may be `null`.** If a run is cut short before any candidate finishes — a `budget` or `time` stop during the initial population fill, or every candidate call failing — there is no champion, and `best` is `null` rather than absent. `result.best.prompt` throws on those runs; check `best` first.

**The exit code tracks "produced a usable champion", not `stopReason`.** A `budget` stop exits 0 when a champion exists and 1 (`Evolution produced no usable result`) when it does not, so the same `stopReason` can exit either way. Branch on `stopReason` and `best`; use the exit code only for "is there anything to read".

**`testSet`** maps each test `id` to its name, mode and holdout flag, so `tests[].testId` inside `generations` resolves without re-reading the config. **`activeDurationMs`** is the time this process spent working — on a `--resume` it excludes the downtime that `durationMs` includes.
