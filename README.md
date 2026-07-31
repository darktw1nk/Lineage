# Lineage

**Stop hand-tuning prompts. Breed them.**

> *"What's the best prompt that stays under 1 cent per call?"*
> *"Maximize accuracy — but punish anything slower than 2 seconds."*
> *"Highest quality that never violates my safety rules, on the cheapest model that can deliver it."*
>
> These are questions you can literally type into a config and get answered — with measurements, not vibes.

Lineage treats a prompt like a genome: it spawns a population of variants, scores every one of them against *your* test set on real models, kills the weak, breeds the strong, and repeats — until it finds a prompt that is measurably better than anything you'd write by hand. Not "feels better" — better on a fitness function you define.

![Evolution run](docs/assets/evolution-run.gif)

*A real 47-second run: 30 candidates, 3 generations, 6 models competing, $0.013 total. The hand-written seed scored 5.30. The evolved champion scored 9.73 — created by crossover of two strong parents, running on a model 25× cheaper than the flagship in the same population.*

## Why this beats prompt engineering by hand

**Prompting is empirical, but nobody treats it that way.** You tweak a word, eyeball three outputs, and ship. Lineage replaces that loop with selection pressure: every candidate is scored on every test, every generation, and only measured improvement survives. The lineage graph shows you exactly which edit earned its place.

**It optimizes trade-offs, not just quality.** Fitness is a weighted blend of five dimensions — quality, safety, cost, latency, stability — so the questions in the header aren't marketing: they're just weight configurations. The population converges toward *your* trade-off, not toward generic eloquence.

**It discovers model arbitrage.** With several models in the gene pool, the model-variation operator keeps re-dealing prompts to different models. Evolution routinely finds that a tuned prompt on a cheap model beats a mediocre prompt on an expensive one — in the demo run above, `gemini-2.5-flash-lite` outscored `gpt-5-mini` candidates at a fraction of the cost.

**It learns from its own failures.** The meta-prompting operator reads the judge's actual feedback on failing tests ("added a preamble", "wrong date format") and performs surgical fixes — not blind rewrites. It's the closest thing to a prompt engineer in the loop, except it reads every test result, every time.

**Your test set becomes an executable spec.** When a provider ships a new model version, rerun the evolution: you'll know in minutes whether your prompt regressed and what to replace it with.

## The genetics

Each generation, the engine:

1. **Evaluates** every candidate against the full test set, in parallel, with per-call cost tracking.
2. **Selects** parents — **Top-K** (take the best K) or **Top-P** (sample by cumulative fitness probability, keeps more diversity), with **elitism** (`eliteShare`): champions survive unchanged, so fitness never regresses. Optionally, a **pairwise playoff** re-ranks the top contenders head-to-head (both presentation orders, position bias cancelled) — decisive exactly where absolute scores cluster at 9.8-vs-9.9.
3. **Distributes offspring** fitness-proportionally: stronger parents get more children.
4. **Breeds** the next generation with five operators, mixed by configurable shares:

| Operator | What it does | Why it's interesting |
|---|---|---|
| **Mutation** | Rewrites guided by a strategy catalog: restructuring, compression, tightening constraints, adding anti-patterns, injecting thinking scaffolds — and *removal* of harmful lines | Strategies are sampled per mutation, so the search explores different editing philosophies, not one style |
| **Crossover** | LLM-merges two strong parents into one prompt without redundancy | The demo's champion was a crossover — traits from two lineages combined |
| **Meta-prompting** | Reads the worst-scoring tests (inputs, outputs, judge justifications) and proposes targeted edits | The only *failure-aware* operator — this is directed evolution, not random walk |
| **Param variation** | Same prompt, different temperature/seed within a configured range | Sometimes the prompt is fine and the sampling is wrong |
| **Model variation** | Same prompt, different model from your enabled set | Turns model choice into a searchable dimension |

Every node carries a **changelog** of what created it (`[MUTATION] Removed vague instruction…`, `[CROSSOVER] Merged a1b2 + c3d4`), and the engine tracks **per-operator effectiveness** (average fitness delta) as the run progresses.

**And the gene pool is open.** Operators are plugins — a ~20-line JS file dropped in a folder joins the breeding mix on equal footing with the built-ins (which run through the same registry). In our first live test, a deterministic section-rotation plugin bred the run's champion (fitness 9.89) while the LLM-powered operators watched. Author guide: [docs/plugins.md](docs/plugins.md).

## Fitness: five dimensions, your weights

```json
"fitness": {
  "weights": { "quality": 1.0, "safety": 0.5, "cost": 0.3, "latency": 0.1, "stability": 0.3 },
  "guardrails": ["Must never invent order numbers", "Must not use profanity"],
  "costNorm":    { "mode": "relative", "maxUSDPerCall": 0.05 },
  "latencyNorm": { "mode": "absolute", "maxMs": 3000 }
}
```

| Dimension | Measured as | The interesting part |
|---|---|---|
| **Quality** | 0–10 average across your tests | Exact-match with partial credit, or LLM-judged against your reference answers |
| **Safety** | 0–10 across **guardrails** — natural-language rules checked by an LLM per output | Write policies in plain English; violations drag fitness down |
| **Cost** | Real USD per candidate, from a maintained per-model price catalog | `relative` mode normalizes against the current population's worst — the bar rises as evolution gets cheaper |
| **Latency** | Measured ms per call | `absolute` (hard ceiling) or `relative` (beat your siblings) |
| **Stability** | Same prompt re-run across different seeds; consistency scored 0–10 | Selects against prompts that only win by luck |

Weights are normalized automatically — only the ratios matter. Set a weight to 0 and that dimension is ignored; crank cost to 1.0 and watch the population race to the bottom of the price list without giving up your quality floor.

## Tests are the spec

Four grading modes, mixable in one test set:

```json
"testSet": [
  { "name": "IP extraction", "mode": "exact_match",
    "prompt": "the server is at one ninety two dot one sixty eight...",
    "expected": "192.168.1.100",
    "grading": { "distanceMetric": "levenshtein", "strictZeroOnDeviation": false } },

  { "name": "Refund summary", "mode": "llm_grade",
    "prompt": "<a realistic customer email>",
    "expected": "Refund request: order #4821, cracked jar, wants replacement." },

  { "name": "Chart reading", "mode": "llm_grade",
    "prompt": "What was Q3 revenue?", "image": "charts/q3.png" },

  { "name": "Unseen case", "mode": "llm_grade",
    "prompt": "<held-back input>", "expected": "<reference>", "holdout": true }
]
```

- **`exact_match`** scores with distance metrics — `levenshtein` (text), `json_diff` (structure-aware for JSON outputs), `numeric_abs` (numbers) — as partial credit on 0–10, or `strictZeroOnDeviation` for all-or-nothing.
- **`llm_grade`** uses a judge model with a rubric (task completion, format compliance, hallucination avoidance, brevity) plus your `expected` as a reference answer — content *and* format consistency are graded. The judge's one-sentence justification is stored per test, per node, so you can read *why* a candidate lost points.
- **`image`** attaches a file for vision-enabled tests — evolve prompts for chart reading, document extraction, UI screenshots.
- **Tool-call & schema tests** — evolve prompts whose success is *"calls the right function with the right arguments"* (`mode: "tool_call"`: tools offered to the model, scored 0/2/6/10 on function + argument match) or *"conforms to this JSON Schema"* (`mode: "json_schema"`). Scored deterministically — no judge, no noise, no grading cost. The dominant prompt genre for agent builders, now evolvable.
- **`holdout` tests are invisible to evolution** — the run ends by scoring both the seed and the champion on them, a generalization number that *can't* be overfit. Instead of flagging tests one by one, `"holdoutShare": 0.2` holds out a seeded fraction of the un-flagged tests (both forms combine; `holdoutSeed` pins the split). Two caveats the report will call out when they happen: the holdout can be **skipped** entirely (budget/time exhausted, manual stop, no champion, or an aborted judge — the report records which), and it can be **contaminated** when a holdout row itself fails to grade (those rows are marked ⚠️ and the delta is not trusted). Add `samplesPerTest` to average away judge noise, and prompts evaluate as real **system messages** by default (the way you'll actually deploy them).
- Every meta-level prompt is overridable via `systemPrompts` — the judge's rubric, the mutation strategy catalog, the crossover and meta-prompting instructions. **The evolution itself is promptable.**

## Dials worth knowing

| Knob | What it changes |
|---|---|
| `selection.policy: "topp"` + `topP: 0.8` | Probabilistic parent sampling instead of hard Top-K — more diversity, less greed |
| `eliteShare` | How much of each generation is guaranteed survivors |
| `operators.*.share` | The breeding mix — crank `metaPrompting` when you have failing tests to learn from, `modelVariation` when hunting cheaper models |
| `paramVariation.temperature.{min,max}` | The temperature range evolution may explore |
| `pairwise.enabled` | Head-to-head playoff among each generation's top contenders — the champion is picked by "which output is better?" comparisons (both orders, position bias cancels), not by a noisy 9.87-vs-9.89 absolute score. Judge-limited: pair it with a strong `serviceModel` |
| `seed` | Reruns become reproducible — same seed, same evolution decisions (operator plan, parents, temperatures, splits). `--seed 42` on the CLI |
| `targets` | Four independent stop conditions: `maxGenerations`, `budgetUSD` (hard spend cap), `targetFitness` (stop early on success), `timeLimitMs` |
| `serviceModel` | The model that powers mutation/crossover/judging — cheap models work remarkably well here |
| `providerOptions` | Passed through to candidate calls (e.g. `reasoning_effort`) |
| `parallelLimit` | Global concurrency across all API calls |
| **Plugins** | Drop a JS file in the plugins folder to add operators or providers — even the five built-in operators run through the same registry ([docs/plugins.md](docs/plugins.md)) |

Everything is tracked: token counts, per-node cost, cache hits (identical prompt+params are never evaluated twice), and a per-purpose cost breakdown the report reconciles against the preflight estimate ("Where the money went"). And everything is **estimated before you spend**: the desktop modal shows a live `≈ $low – $high · ~N calls` band as you configure, and `--estimate` prints the same preflight breakdown from the CLI without running anything.

## Two ways to run it

| | For | Interface |
|---|---|---|
| **Desktop app** | Humans | Live React Flow lineage graph — watch selection happen |
| **`lineage` CLI** | AI agents, CI, scripts | JSON in → JSON out, exit codes, budget caps |

Both drive the same engine (`@lineage/core`).

```bash
npm install
npm run cli -- --init                                       # writes a runnable evolve.json to start from
npm run cli -- --config evolve.json --output results.json   # agents: JSON in, JSON out
npm run electron:dev                                         # humans: watch it evolve
```

That's the whole idea — everything else (keys, model discovery, installers, packages, troubleshooting) lives in **[docs/install.md](docs/install.md)**, and the full config reference in **[docs/cli.md](docs/cli.md)**. A small run costs **under a cent**. Using Claude Code? The repo ships an [`evolving-prompts` skill](.claude/skills/evolving-prompts/SKILL.md) that teaches agents the whole workflow.

In the desktop app, models load from the catalog with live pricing:

![New evaluation](docs/assets/new-evaluation.png)

Watch generations appear with full lineage, then click any node: its evolved prompt, the changelog of what created it, per-test scores with the judge's reasoning, and exact cost:

![Evolution graph](docs/assets/evolution-graph.png)

![Node details](docs/assets/node-details.png)

## Providers & repository layout

**Providers**: OpenAI, Anthropic, Google Gemini, Groq directly — any model via OpenRouter (one key, synced catalog with pricing) — or bring your own via a provider plugin (the shipped [Ollama example](examples/plugins/ollama/index.mjs) runs evolution on free local models).

```
packages/core     @lineage/core — engine, operators, providers, sql.js persistence
packages/cli      @lineage/cli  — the lineage command
apps/desktop      Electron app (React + React Flow)
examples/plugins  drop-in operator/provider examples (section-shuffle, Ollama)
docs/cli.md       Full CLI + config reference
docs/plugins.md   Plugin author guide
```

Architecture details in [CLAUDE.md](CLAUDE.md). Tests: `npm test` (1,269 across all packages — including end-to-end evolutions driven entirely by plugins, and twenty adversarial bug-hunt passes' worth of regression pins; the hunt logs live in [docs/analysis/](docs/analysis/)).

## License

[MIT](LICENSE)
