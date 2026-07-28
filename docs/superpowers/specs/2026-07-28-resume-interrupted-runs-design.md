# Checkpointing + Resume for Interrupted Runs

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

A run killed mid-flight (Ctrl+C, crash, network death, app quit) loses nothing: every completed node and generation is already in the database, the spend is on the meter, and `promptengine --resume <runId>` (CLI) or a Resume button (desktop) continues the run from where it stopped. Today `run_json` is written only by `finishEvaluation` (`evaluator_v2.ts` ~line 1128 is the sole mid-run UPDATE) — an interruption loses the ENTIRE run, not just the current generation.

## 1. Engine checkpointing (`packages/core/src/engine/evaluator_v2.ts`)

- New helper `persistRun(state: EvaluationState): void` — the same `UPDATE evaluation_runs SET run_json = ? WHERE id = ?` that `finishEvaluation` performs, serializing `state.run` (which carries `status: 'running'` mid-run). `finishEvaluation` keeps setting `status: 'finished'` before its own persist — that status difference is how resume tells interrupted from done.
- Call sites: (a) after a node reaches terminal status (`finished`/`error`) — the point that emits the final `node_updated` for that node; (b) after `generation_created`; (c) after a playoff is appended to `run.playoffs`; (d) after the holdout result is set; (e) on pause. sql.js debounces file writes (50ms), so bursts of parallel node finishes coalesce.
- `finishEvaluation` refactors to use `persistRun` (single serialization path).

## 2. Resume semantics (core)

- `startEvaluation(runId, config, run)` gains a resume path, triggered when `run.generations.length > 0` (a fresh run always starts `[]` → no API change for hosts; the loaded, checkpointed run IS the signal).
- Guard: if `run.status === 'finished'`, throw `Error('Run <id> is already finished')`. Any other persisted status ('running', 'pausing', 'paused') is resumable.
- State rebuild:
  - `currentGeneration` = `run.generations.length - 1`; `state.run` = the loaded run with `status: 'running'`, `stopReason` cleared.
  - Nodes with status `finished`/`error`: kept untouched (scores, tests, metrics preserved).
  - Nodes in any other status: reset to their pre-evaluation state — status `awaiting`, `tests`/`metrics` cleared — and re-queued. Exception: generation-0 nodes whose fill mutation never completed (changelog still `Waiting for mutation...`): reset to `pending` and re-run through the fill-mutation path (same `rngFor(seed, 'fill', index)` stream → deterministic under a seed).
  - Results cache re-seeded from every kept finished node via the existing cache-key derivation (prompt/params/harness), so re-encountered prompts hit cache.
  - `totals` and `cacheHits` restored from the loaded run — `targets.budgetUSD` therefore enforces against CUMULATIVE spend across interruptions.
  - `run.playoffs` restored — `maybeRunPlayoff`'s existing per-generation dedupe guard prevents re-judging completed playoffs.
  - Holdout: partition re-derived from config (deterministic: `holdoutSeed ?? seed ?? 42`); holdout evaluation runs at finish as usual.
  - Seeded runs resume bit-deterministically for all remaining decisions: derived RNG streams are keyed by stable labels (generation, child index), so there is no consumed-stream state to restore.
- New tiny export `isEvaluationActive(runId: UUID): boolean` (checks `activeEvaluations`) so hosts can distinguish "interrupted" from "currently running".

## 3. CLI (`packages/cli/src`)

- `--resume <runId>` flag. It replaces `--config` as the RUN source (the evaluation config always comes from the DB); `--config` may still be passed alongside purely to re-supply file-based extras (step 3). Flow:
  1. Open the DB (`--db` as usual), load the run row; error clearly if missing or `finished`.
  2. Load `config_json` via the run's `config_id` → `EvaluationConfig`.
  3. Keys resolve as today: env vars > config keys > shared electron-store. Optional `--config <file>` ALONGSIDE `--resume` re-supplies file-based extras the DB doesn't store: config-file API keys, `systemPrompts` overrides, and `plugins` to re-register custom operators (unregistered plugin operators fall back to the existing CARRY path — safe, logged).
  4. Pre-seed the collector from the restored run (generations, totals, cacheHits) so results.json and the report span ALL generations, then call `startEvaluation` and stream as usual.
  5. stderr: `Resuming run <id8> from generation N (<X> finished nodes, $<Y> already spent)`.
- Help text + `docs/cli.md` section "Resuming interrupted runs" (includes the plugins/systemPrompts caveat and that `--seed`ed runs resume deterministically).

## 4. Desktop (`apps/desktop`)

- IPC: new `eval:resume-run` handler — loads run + config from DB, guards (`finished` → error toast; already active → no-op), calls `startEvaluation`. Preload exposes `resumeRun(runId)`.
- `eval:list` rows gain `interrupted: boolean` (`run.status !== 'finished' && !isEvaluationActive(run.id)`).
- History list: interrupted runs show an amber "interrupted" badge and a Resume button wired to `resumeRun`; on success the run streams live like any other (subscribe on click).
- Live pause/resume (`eval:pause`/`eval:resume`) untouched.

## 5. Out of scope

Resuming across config edits (config is immutable per run); resuming `finished` runs (that is "reseed a new run", already supported by workflow); process-level signal handling (SIGINT graceful flush — the checkpoint cadence makes it unnecessary); replaying LLM outputs.

## 6. Testing

- **Checkpoint unit**: spy on the DB statement — an evaluation run with a fake adapter fires `UPDATE evaluation_runs` at node-terminal and generation boundaries (count > 2 before finish), and the checkpointed JSON mid-run parses with `status: 'running'`.
- **Resume E2E** (fidelity-harness style): hand-built half-finished run fixture — gen 0 complete, gen 1 with 1 finished + 2 awaiting nodes — inserted into the DB, then `startEvaluation` with the loaded run:
  - completes only unfinished work (adapter call count proves finished nodes are not re-evaluated);
  - totals grow FROM the restored base (assert final ≥ restored, and restored spend included);
  - final run has all generations and reaches `finished`;
  - `finished` runs refuse to resume (throws);
  - gen-0 pending fill node gets mutated on resume.
- **Determinism**: with `seed` set, an interrupted-then-resumed run produces the same decision signature (operator labels, temperatures, node seeds) as an uninterrupted run of the same seed — the resumed half must match the uninterrupted run's corresponding generations.
- **CLI**: arg parsing (`--resume` id captured; integer-free); collector pre-seeding covered by the E2E-style test at CLI level if cheap, else engine-level only.
- **Live**: real flash-lite CLI run killed mid-generation (taskkill), then `--resume` completes it; report spans all generations; totals cumulative; desktop smoke — interrupted run shows Resume button (CDP), clicking it completes the run.
- Definition of done: full suite + type-check green; live kill-resume verified.
