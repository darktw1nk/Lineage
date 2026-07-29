# Categorized Cost Accounting (replaces the never-written cost_ledger)

**Date**: 2026-07-29
**Status**: Approved design, pending implementation plan

## Goal

Answer "where did my money go?" on every run: a per-purpose and per-model cost breakdown accumulated during the run, surfaced in `results.json` and as an estimated-vs-actual "Where the money went" table in the report. The vestigial `cost_ledger` table (schema exists, desktop deletes from it, nothing ever inserts) is dropped.

## Data shape (`packages/core/src/types.ts`)

```ts
// EvaluationRun gains:
costBreakdown?: Record<string, { calls: number; promptTokens: number; completionTokens: number; usd: number }>;
estimate?: { calls: number; low: number; high: number; breakdown: Array<{ label: string; calls: number; low: number; high: number }> }; // full preflight snapshot, stamped at run start
```

- Breakdown keys are EXACTLY the labels `estimateRunCost` emits — the shared constant `COST_LABELS` (exported from `engine/estimate.ts`) becomes the single source: `Population fill (mutations)`, `Candidate evaluations`, `LLM grading`, `Safety guardrails`, `Stability re-runs`, `Genetic operators`, `Pairwise playoffs`, `Holdout evaluation`, `Holdout grading`. `estimateRunCost`'s `add(...)` calls switch to these constants (behavior unchanged; unit tests keep passing by construction).
- Per-model entries live in the SAME map under a `model:` prefix — e.g. `model:gemini/gemini-2.5-flash-lite` — one record type, two groupings. Consumers split on the prefix.
- Living on `run_json` ⇒ checkpoints, resume, and desktop history persistence work with zero extra plumbing. Sums-equal-totals is an invariant by construction (see accrual).

## Accrual (`packages/core/src/engine/evaluator_v2.ts`)

- New module-private helper — the ONLY place totals arithmetic lives afterwards:

```ts
function accrueCost(
  state: EvaluationState,
  purpose: string,                       // a COST_LABELS value
  model: ModelRef,
  c: { usd: number; promptTokens: number; completionTokens: number; calls: number },
): void
```

It adds to `state.run.totals`, to `costBreakdown[purpose]`, and to `costBreakdown['model:' + provider + '/' + model]` (creating zeroed records on first touch). The ~8 existing scattered `state.run.totals.x +=` blocks are replaced with `accrueCost` calls: fill (`Population fill (mutations)`, service model), candidate samples (`Candidate evaluations`, node's model), grading (`LLM grading`, service), safety (`Safety guardrails`, service), stability (`Stability re-runs`, node's model), generation transition costTracking (`Genetic operators`, service), playoff accrue callback (`Pairwise playoffs`, service).
- Holdout: `EvaluationState.costContext: 'evolution' | 'holdout'` (default `'evolution'`); `runHoldoutEvaluation` sets `'holdout'` for its duration (finally-restored). `runSingleSample`'s candidate/grading accruals pick labels by context: holdout ⇒ `Holdout evaluation` / `Holdout grading`.
- The existing `totals` sendUpdate cadence is unchanged (events still fire where they fire today; accrueCost does not send events itself).
- `finishEvaluation` emits `sendUpdate(runId, { type: 'cost_breakdown', breakdown: state.run.costBreakdown, estimate: state.run.estimate })` before the finished status (checkpointed run_json carries it anyway; the event is for the CLI collector).

## Estimate stamping

- CLI `runEvolution` (fresh-run banner block): after computing the banner estimate, `run.estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };` BEFORE the run INSERT and `startEvaluation`. Resume: a stamped estimate rides along untouched.
- Desktop `eval:create` handler: same stamp via `estimateRunCost(config, getModelCost)` in a try/catch (estimation failure never blocks creation).
- `startEvaluation`'s `state.run = { ...run, ... }` spread preserves both new fields (verify no field-list rebuild drops them).

## Surfaces

- **CLI collector** (`packages/cli/src/engine.ts`): `case 'cost_breakdown'` stores both; `EvolutionResult` gains `costBreakdown?` + `estimate?`; `buildResult` includes them.
- **Report** (`packages/cli/src/report.ts`): new section after the Run Configuration table — `## Where the money went`. Header line: `Estimated: $low – $high (~N calls) · Actual: $X (M calls)` (omitted when no stamped estimate). Table: one row per purpose label present in EITHER the actual breakdown or the stamped estimate breakdown (skip `model:` entries), columns `Purpose | Est. calls | Calls | Est. $ | Actual $` — `Est. $` rendered as the `low–high` band, `—` for a side with no data — plus a totals row. Below the table, one line: `**By model:** provider/model $X (N calls), …` from the `model:` entries.
- **Desktop store**: one-line `case 'cost_breakdown': break;` (silence the unknown-event warn); display panel out of scope.
- **Docs**: `docs/cli.md` — short "Cost breakdown" paragraph (results.json field + report table; the judge-vs-candidate insight). `evolving-prompts` SKILL.md — one bullet: read `costBreakdown` to see whether judge spend dominates; if so, cheapen `serviceModel`.

## Migration (schema v4)

- `database/init.ts`: bump to v4 via the existing `setVersion` pattern: `DROP TABLE IF EXISTS cost_ledger;`. Remove the `CREATE TABLE cost_ledger` block. Desktop `handlers.ts`: delete the orphaned `DELETE FROM cost_ledger WHERE run_id = ?` line.

## Out of scope

Per-call ledger rows; desktop breakdown panel; backfilling historical runs.

## Testing

- **Unit**: `accrueCost` creates records, aggregates, and maintains sums-equal-totals across mixed purposes/models.
- **E2E** (fidelity harness, deterministic adapter, config exercising fill + evals + grading + playoff + holdout): every expected label present; NO unexpected labels; `Σ breakdown[purpose].usd === totals.usd` and same for calls/tokens (purpose entries only — model entries sum identically); holdout calls land in the holdout labels, not evolution ones; `cost_breakdown` event emitted before finished.
- **Resume**: extend the resume E2E — a truncated run's breakdown survives and continues accumulating (final sums still match final totals).
- **Migration**: a v3 DB containing a `cost_ledger` table opens cleanly at v4 with the table gone (wrapper-test pattern with a legacy fixture).
- **CLI**: results.json includes `costBreakdown` + `estimate` (fake-provider run through `runEvolution` if cheap, else covered live).
- **Live**: real flash-lite run — report shows "Where the money went" with sums matching totals and the run-level estimated-vs-actual line; actual inside the stamped band.
- Definition of done: full suite + bare type-check green; live verification reported.
