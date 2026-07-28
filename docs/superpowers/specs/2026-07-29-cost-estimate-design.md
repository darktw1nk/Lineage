# Preflight Cost Estimate

**Date**: 2026-07-29
**Status**: Approved design, pending implementation plan

## Goal

Show expected spend BEFORE anything runs: a startup banner + `--estimate` dry-run flag in the CLI, and a live estimate line in the desktop New Evaluation modal. Pure arithmetic — the estimate itself costs zero LLM calls.

## Core estimator (`packages/core/src/engine/estimate.ts`, new)

```ts
export interface CostEstimate {
  calls: number;                 // expected LLM calls (rounded)
  low: number;                   // USD, optimistic completion lengths
  high: number;                  // USD, pessimistic completion lengths
  perGeneration: boolean;        // true when targets.maxGenerations is unset
  breakdown: Array<{ label: string; calls: number; low: number; high: number }>;
  warnings: string[];
}

export async function estimateRunCost(
  config: EvaluationConfig,
  getCost: (model: ModelRef) => Promise<ModelCostEntry | null>,
): Promise<CostEstimate>
```

### Call model

Let `G = targets.maxGenerations` (if unset: estimate ONE generation-0 pass + one transition, set `perGeneration: true`); `N = population.generationSize`, `N0 = population.initialSize`; `E = selection.eliteShare > 0 ? max(1, round(N × selection.eliteShare)) : 0`; partition the test set first (`holdoutSeed ?? seed ?? 42`) → `F` fitness tests, `H` holdout tests (`H_llm` of them llm_grade), `L` = llm_grade fitness tests, `S = clamp(samplesPerTest ?? 1, 1, 10)`, and `nodes = N0 + (G−1) × (N − E)` (all evaluated nodes across the run).

| Phase | Calls | Model priced |
|---|---|---|
| Gen-0 fill | `(N0 − 1) × 2` | service |
| Candidate evals | `[N0 + (G−1) × (N − E)] × F × S` | candidates (averaged) |
| LLM grading | `[N0 + (G−1) × (N − E)] × L × S` | service |
| Safety (if `weights.safety` && guardrails) | `nodes × guardrails.length` | service |
| Stability (if `weights.stability`) | `nodes × 3` | candidates |
| Operator transitions | `(G−1) × Σ_children(op)`: mutation 2, meta 2, crossover 1, param/model/plugin 0 per child; children `N − E` split by normalized shares (round, plugins counted at 0 with a warning) | service |
| Pairwise playoff (if enabled) | `G × C(min(contenders, N), 2) × L × 2` | service |
| Holdout (if `H > 0`) | `2 × H × S` (+ grading `2 × H_llm × S`) | candidates + service |

### Token & price model

- Prompt tokens per candidate call: `ceil((len(seedPrompt) + len(test.prompt)) / 4) × 1.2` (real per-test lengths; the 1.2 covers prompt growth across generations). Service calls (grading/operators/playoff): candidate-prompt tokens + a fixed 400-token template overhead.
- Completion tokens: **low** 100 per candidate call, **high** `min(maxTokens ?? 20000, 1024)`; judge/service calls low 80 / high 250 (they return small JSON); mutation/meta apply calls low 200 / high `min(maxTokens, 1024)` (they emit whole prompts).
- Price per call from `getCost({provider, model})`; candidate calls averaged across `enabledModels` with equal weight (gen-0 assigns models round-robin; later generations drift — equal weight is the honest simple assumption).
- `getCost` returns null / zero-priced → warning `"<provider>/<model> not in catalog — estimated at $0"` and continue.
- Warnings additionally: `"budgetUSD ($X) is below the low estimate — the run will likely stop early"` when applicable; always append `"cache hits and early stops reduce actual spend"`.

## CLI (`packages/cli/src`)

- Startup banner (fresh runs, after the Budget line): `Estimated cost: $<low> – $<high> (~<calls> calls)` + each warning on its own stderr line. Estimation failure never blocks a run (catch → single stderr note).
- `--estimate` flag: loads config exactly like a run (store shim, DB for the cost catalog, holdout partition) but starts nothing: prints the `CostEstimate` JSON to stdout, a human breakdown table to stderr, exits 0. Composes with `--config` only (no run id semantics).
- `docs/cli.md`: usage line + a short "Cost estimation" paragraph (band semantics: completion lengths are the unknown; the band brackets them). `evolving-prompts` SKILL.md: bullet — run `--estimate` first when budget matters; treat `high` as the commit number.

## Desktop (`apps/desktop`)

- New IPC `eval:estimate` (handler calls `estimateRunCost` with the DB-backed `getModelCost`); preload exposes `eval.estimate(config)`.
- NewEvaluationModal: an estimate line in the footer next to Start — `≈ $0.004 – $0.02 · ~86 calls` — recomputed debounced (400ms) on config change; warnings as a tooltip/inline muted text; renders nothing (no error state) while the config is incomplete (no models/tests).

## Out of scope

Micro-probe calibration (sampling real completion lengths); modeling cache hit rates; modeling early stops (`targetFitness`/budget trips); per-model weighting by selection dynamics; resume-run estimation.

## Testing

- **Unit** (fixed in-memory cost table): hand-computed call counts for a small config (N0=3, N=3, G=2, E=1, F=2 incl. 1 llm_grade, S=1) exactly matching `calls` and breakdown rows; each phase toggles independently (playoff on/off, holdout via flagged test, safety, stability, samples ×3 scaling, plugins-share warning); unset maxGenerations → `perGeneration: true`; uncatalogued model + low-budget warnings; low ≤ high always.
- **CLI**: `--estimate` prints valid JSON to stdout with `calls > 0` and exits 0 without touching `evaluation_runs` (run count unchanged in the DB).
- **Calibration (live)**: estimate the exact config of a real flash-lite run, then run it — actual `totals.usd` must fall inside `[low × 0.5, high]` and actual `totals.calls` within ±30% of estimated `calls` (report the numbers either way).
- **Desktop CDP smoke**: estimate line appears in the modal, and changing `samplesPerTest` from 1→3 visibly increases the displayed band.
- Definition of done: full suite + bare type-check green; calibration run reported.
