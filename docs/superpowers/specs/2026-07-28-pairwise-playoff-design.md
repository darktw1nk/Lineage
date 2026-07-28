# Pairwise Playoff Judging

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

Absolute 0–10 LLM scores cluster in late generations where a 9.87-vs-9.89 distinction is noise. A pairwise playoff among each generation's top contenders — judged on stored outputs with position-bias cancellation — decides selection order, the elite, and the champion, exactly where absolute scoring is weakest. Absolute fitness remains the base metric (cheap, cacheable, cross-generation comparable) and is not modified.

Decisions locked during brainstorming: hybrid playoff (not full Elo fitness, not champion-anchored scoring); both-orders judging per pair (position bias canceled per match).

## Configuration

- `EvaluationConfig` gains `pairwise?: { enabled: boolean; contenders?: number }`.
  - Opt-in (`enabled: true` required) — it spends service-model tokens.
  - `contenders` default 4, clamped to 2..8 at run start (warn when clamped).
- New overridable system prompt key: `systemPrompts.pairwiseJudgingPrompt` (same store-override pattern as `llmGradingPrompt`). Template variables: `${testPrompt}`, `${expectedBlock}` (empty string or a labeled reference block), `${outputA}`, `${outputB}`. Default template returns strict JSON `{"winner": "A"|"B"|"tie", "reason": "<one sentence>"}`.

## Playoff module (`packages/core/src/engine/pairwise.ts`, new)

`runPairwisePlayoff(opts): Promise<PlayoffResult | null>` with:

```ts
interface PlayoffOptions {
  contenders: CandidateNode[];      // top-M by fitness, finished, already ordered by fitness desc
  tests: TestCase[];                // the run's llm_grade fitness tests only
  config: EvaluationConfig;         // serviceModel, serviceModelMaxTokens, retries
  accrue: (usd: number, promptTokens: number, completionTokens: number) => void; // cost callback, once per judge call
  shouldAbort?: () => boolean;      // checked between pairs; true → abandon remaining matches (e.g. budget tripped)
}

interface PlayoffResult {
  ranking: UUID[];                  // best first; length === contenders.length
  points: Record<UUID, number>;     // Copeland points
  matches: number;                  // judge calls made
}
```

Mechanics:
- Skip (return null) when: fewer than 2 contenders, or `tests` empty.
- For every unordered pair (a, b) and every test: retrieve each node's stored `TestResult.outputText` for that test (first sample). If either side lacks output text, skip that pair-test.
- Two judge calls per pair-test: A-first and B-first. Verdict parsing: strip markdown fences, `JSON.parse`, accept `winner` values `A`/`B`/`tie` case-insensitively; unparseable or invalid verdict counts as `tie` for that call (logged).
- Combining the two calls: both name the same NODE (accounting for the order swap) → that node gets 1 point for the match; any other combination (disagreement, one or two ties) → 0.5 points each.
- Ranking: Copeland points descending; tie on points → higher absolute fitness first; still tied → earlier contender order (stable).
- Judge calls go through `getProviderAdapter(config.serviceModel.provider)` with temperature 0.3 and the run's `serviceModelMaxTokens`; each call's usd/tokens reported through `accrue`.

### Cost accounting (hard requirement)

Playoff judge calls are evaluation costs, accounted identically to LLM-grading calls:
- Every judge call adds its `usd`, `promptTokens`, `completionTokens`, and one `calls` increment to `state.run.totals` (via `accrue`), and emits a `totals` event immediately — the desktop spend counter and CLI totals tick during the playoff, not after.
- The spend counts against `targets.budgetUSD`: the playoff checks the budget before starting AND between pairs — if the budget trips mid-playoff, remaining matches are abandoned, the ranking is computed from completed matches only, and a warning is logged.
- `results.json` totals and the report's cost figures therefore include playoff spend with no separate bookkeeping; the `playoff_result` event carries `matches` (judge-call count) so the playoff's share is auditable.
- Any judge-call throw (after adapter retry) → that call is a `tie` verdict (playoff never crashes the run); error logged.

## Engine integration (`evaluator_v2.ts`)

- `EvaluationState` gains `pairwiseEnabled: boolean` and `pairwiseContenders: number` (resolved + clamped at `startEvaluation`), and `lastPlayoff: { generation: number; ranking: UUID[] } | null`.
- In `moveToNextGeneration` (and wherever the generation is finalized before `selectTopPerformers` at evaluator line ~947): when enabled and the current generation has ≥2 finished nodes and ≥1 llm_grade fitness test:
  1. Contenders = top `pairwiseContenders` finished nodes by fitness.
  2. Budget check first: if `budgetUSD` exhausted, skip with a warning.
  3. `runPairwisePlayoff(...)` with `accrue` wired to `state.run.totals` + `totals` events.
  4. Write `metrics.playoffRank` (1-based) onto each contender per the ranking; send `node_updated` for each.
  5. Set `state.lastPlayoff`; append `{ generation, ranking }` to `state.run.playoffs` (new `EvaluationRun.playoffs?: Array<{ generation: number; ranking: UUID[] }>`); emit `sendUpdate(runId, { type: 'playoff_result', generation, ranking, matches })`.
- **Selection**: `selectTopPerformers` sort becomes rank-aware: `(a.metrics?.playoffRank ?? Infinity) - (b.metrics?.playoffRank ?? Infinity)` first, then fitness descending. (Nodes from earlier generations carry stale playoffRank only within their own generation's array — selection operates on the current generation, so no cross-generation contamination.)
- **Elitism**: the elite sort in `createNextGeneration` uses the same rank-aware comparator.
- **Champion**: `runHoldoutEvaluation` (and any best-node resolution inside the engine) prefers the node with `playoffRank === 1` in the highest generation that has a playoff; falls back to max fitness.
- `metrics.playoffRank` must be cleared on elite CLONES carried into the next generation (the clone gets a fresh id and competes in the next playoff on its own results) — strip `playoffRank` when building `eliteClone.metrics`.

## Types (`types.ts`)

- `CandidateNode.metrics` gains `playoffRank?: number`.
- `EvaluationConfig` gains `pairwise` (above).
- `EvaluationRun` gains `playoffs?: Array<{ generation: number; ranking: UUID[] }>`.

## CLI / report / desktop

- **CLI config** (`packages/cli/src/config.ts`): `pairwise?: { enabled: boolean; contenders?: number }` passthrough.
- **CLI collector** (`engine.ts`): handle `playoff_result` → `collector.playoffs.push(...)`; `EvolutionResult.playoffs?` included in results.json. `buildResult`'s `best` selection prefers the final playoff winner (rank-1 node from the latest playoff generation, resolved from collected nodes) over max-fitness; falls back unchanged.
- **Report** (`report.ts`): when playoffs exist, the "Best Evolved Prompt" section notes `Champion selected by pairwise playoff (N contenders, both-orders judging).`
- **Desktop**: Node Details metrics area shows `Playoff: #N` when `metrics.playoffRank` present (RightPanel); NewEvaluationModal gains a "Pairwise playoff" toggle + contenders input in the Service tab's "Evaluation harness" section. No other UI.
- **Docs**: `docs/cli.md` "Evaluation fidelity" section gains a pairwise entry; README "The genetics" selection step mentions the optional playoff; `evolving-prompts` skill gains one line recommending `pairwise.enabled` for llm_grade-heavy runs.

## Out of scope

Elo/Bradley-Terry strength models; Swiss/bracket scheduling; pairwise across generations; judging exact_match tests; re-generating outputs for matches; multi-judge ensembles.

## Testing

- **Module**: scripted judge adapter (registered fake provider or injected adapter): clean A/B agreement → 1 point; disagreement → 0.5/0.5; judge always picks first-shown position → every match 0.5/0.5 (bias-cancellation proof); fence-wrapped verdict JSON parsed; invalid verdict → tie; missing outputText skips pair-test; Copeland ranking with fitness tiebreak; **accrue called once per judge call with the call's real usd/tokens, and the E2E asserts run totals grew by exactly the playoff's judge-call count**; mid-playoff budget trip abandons remaining matches.
- **Selection**: rank-aware ordering in `selectTopPerformers` (rank 1 outranks higher raw fitness); elite pick honors rank; elite clone sheds `playoffRank`.
- **E2E** (fidelity-test style, fake provider whose judge verdict picks the output containing a marker substring): marked node becomes elite and champion; `playoff_result` emitted; `run.playoffs` populated; holdout evaluates the playoff winner as champion.
- **CLI**: config passthrough; results.json `playoffs`; best = playoff winner.
- Definition of done: full suite + type-check green; live flash-lite run with `pairwise.enabled` showing playoff logs, `playoffRank` in results, and the report's playoff note.
