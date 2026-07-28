# Evaluation Fidelity: System Roles, Samples-per-Test, Holdout Split

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

Make the tool's measurements trustworthy and transferable:
1. Candidate prompts are evaluated the way they are deployed — as **system messages**, with the test input as the user message (default; opt-out available).
2. **Samples-per-test averaging** damps LLM-judge and sampling noise.
3. A **holdout split** produces the honest headline: the champion's score on tests evolution never saw, reported against the seed prompt's score on the same tests.

Decisions locked during brainstorming: system-role is the DEFAULT (`promptMode: 'inline'` is the escape hatch); holdout selection supports BOTH per-test flags and a seeded automatic share (flags take precedence; the share splits the remaining tests).

## A. System-role harness

### Types (`packages/core/src/types.ts`)
- `ProviderAdapter.call(opts)` and `BaseProviderAdapter.callAPI(opts)` gain `system?: string`.
- `EvaluationConfig` gains `promptMode?: 'system' | 'inline'` (absent = `'system'`).

### Adapters (`packages/core/src/providers/*`)
When `system` is present:
- **openai.ts, openrouter.ts, groq.ts** (OpenAI-compatible chat payloads): prepend `{ role: 'system', content: system }` to the messages array.
- **anthropic.ts**: pass top-level `system` parameter.
- **gemini.ts**: pass `systemInstruction: { parts: [{ text: system }] }`.
When `system` is absent, request bodies are byte-identical to today.

### Evaluator (`packages/core/src/engine/evaluator_v2.ts`, runTests)
- `promptMode === 'system'` (default): `adapter.call({ system: node.prompt, prompt: test.prompt, ... })`.
- `promptMode === 'inline'`: current behavior — `adapter.call({ prompt: node.prompt + '\n\n' + test.prompt })`.
- Service-model calls (mutation/crossover/meta/judge/safety) are UNCHANGED in this phase.
- The LLM judge continues to receive the candidate prompt and test input as separate labeled blocks (no change needed there).

## B. Samples-per-test

- `EvaluationConfig` gains `samplesPerTest?: number` (absent = 1; clamp to 1..10 at run start with a warning when clamped).
- In `runTests`, each test executes `samplesPerTest` model calls; each sample is independently graded (exact_match distance or LLM judge — judge cost scales with N and counts toward budget).
- **Seed handling**: if `node.params.seed` is set, sample i uses `seed + i`; otherwise no seed is sent (natural sampling variance).
- `TestResult` changes: `score` = mean of sample scores; `passed`: for `llm_grade`, mean score ≥ 7 (today's threshold applied to the mean); for `exact_match`, a strict majority of samples must match exactly (ties fail). `promptTokens`/`completionTokens` = sums across samples; `latencyMs` = mean; new field `samples?: number[]` (individual scores, present only when `samplesPerTest > 1`); `outputText`/`llmGradeReasoning` = from the FIRST sample (representative).
- Cache key (evaluator ~line 645) extends to include `promptMode`, `samplesPerTest`, and the fitness-test signature (see C).

## C. Holdout split

### Configuration
- `TestCase` gains `holdout?: boolean` — explicitly held out.
- `EvaluationConfig` gains `holdoutShare?: number` (0..1, absent = 0) and `holdoutSeed?: number` (absent = 42).

### Partition (new pure function in `packages/core/src/engine/holdout.ts`)
`partitionTestSet(testSet, holdoutShare, holdoutSeed) => { fitnessTests, holdoutTests }`
- Tests with `holdout: true` → holdoutTests, always.
- From the REMAINING tests, `floor(remaining.length * holdoutShare)` are moved to holdoutTests, chosen by a seeded Fisher–Yates shuffle (mulberry32 or equivalent PRNG seeded with `holdoutSeed`) — deterministic for a given (testSet order, share, seed).
- Guard: if `fitnessTests.length === 0`, `startEvaluation` fails fast with `Error('Holdout configuration leaves no fitness tests')` (CLI exits 1; UI surfaces the error).

### During evolution
- `runTests`, fitness, caching (`testSetSig`), and meta-prompting failure summaries use **fitnessTests only**. Holdout tests are invisible to selection pressure.

### After evolution (in `finishEvaluation` flow, before the final persist)
- If `holdoutTests.length > 0` and the run finished with a best node:
  - Evaluate the **champion prompt** and the **seed prompt** (`config.population.seedPrompt`) on holdoutTests — both with the champion's model/params, the run's `promptMode` and `samplesPerTest`. Costs/tokens accrue to run totals (budget: if `budgetUSD` is already exhausted, skip holdout with a console warning and `holdout: { skipped: 'budget' }`).
  - Compute per-prompt mean score (0..10, quality only — no fitness weighting).
- Persist on the run object and emit `sendUpdate(runId, { type: 'holdout_result', holdout })`:

```ts
holdout?: {
  testIds: UUID[];
  samplesPerTest: number;
  seed?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
  champion?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
  skipped?: 'budget' | 'no-champion';
}
```
(`EvaluationRun` type gains this optional field.)

### Reporting
- CLI `results.json`: `holdout` field included verbatim; stderr summary prints `Generalization (unseen tests): seed <X> → champion <Y>`.
- CLI markdown report: a "Generalization" section with the per-test table.
- Desktop: the CLI collector already stores whatever the engine sends; the renderer Footer shows `Holdout: <X> → <Y>` when the selected run has a holdout result (data reaches the renderer via the persisted run in `eval:list` and the `holdout_result` live event handled by the store as a run-field update).

## D. Config/UI/docs surface

- **CLI config** (`packages/cli/src/config.ts`): passthrough for `promptMode`, `samplesPerTest`, `holdoutShare`, `holdoutSeed`, and per-test `holdout`.
- **NewEvaluationModal**: per-test "Holdout" checkbox in the Test Set tab; `promptMode` select and `samplesPerTest` number input in Advanced mode (Main tab section "Evaluation harness"); `holdoutShare`/`holdoutSeed` inputs next to them.
- **evaluationStore**: handle `holdout_result` by merging `holdout` into the run.
- **docs/cli.md**: new "Evaluation fidelity" section documenting all four fields + per-test flag + seed-sample interaction note (temperature 0 + fixed seed makes samples redundant).
- **README**: "Tests are the spec" example gains `"holdout": true` on one test and mentions `samplesPerTest`; one line in the fitness section: headline scores can come from unseen tests.
- **evolving-prompts skill**: add holdout + samplesPerTest guidance (small edit — recommend a holdout test and samples ≥ 2 for llm_grade when budget allows).

## E. Out of scope

Multi-turn `messages` test format; role separation for service-model calls; pairwise judging; ensemble judges; per-provider `response_format`/tool-call evaluation.

## F. Testing

- **Adapters**: mocked-fetch request-shape tests per provider — with `system` present (correct placement: messages[0] role system / top-level system / systemInstruction) and absent (payload unchanged).
- **Partition**: flag precedence, share math, seed determinism (same seed → same split; different seed → different split), empty-fitness guard.
- **Samples**: counting mock adapter — N calls per test, mean scoring, `samples` array, token summing, seed+i propagation.
- **Cache**: key differs across `promptMode`, `samplesPerTest`, and fitness-test partition.
- **E2E** (extend `examples.test.ts` pattern — echo provider, no LLM): run with one flagged holdout test + `samplesPerTest: 2`; assert holdout test never executed during generations (echo call log), `holdout_result` emitted with seed AND champion scores, run totals include holdout calls.
- **CLI**: config passthrough tests; results.json contains `holdout`.
- Definition of done: full suite green, type-check clean, plus one real paid mini-run (flash-lite) demonstrating `promptMode: 'system'`, `samplesPerTest: 2`, and a holdout generalization line in the report.
