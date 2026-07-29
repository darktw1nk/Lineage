# Categorized Cost Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-purpose + per-model cost breakdown accumulated on the run via one `accrueCost` helper, stamped with the preflight estimate, surfaced as `costBreakdown` in results.json and a per-label estimated-vs-actual "Where the money went" report table; the never-written `cost_ledger` table is dropped (schema v4).

**Architecture:** `COST_LABELS` (exported from `engine/estimate.ts`) is the shared vocabulary between estimator and runtime accounting. `accrueCost(state, purpose, model, costs)` replaces the seven scattered totals blocks and maintains totals + per-purpose + `model:`-prefixed per-model records in one place — sums-equal-totals by construction. A `costContext` flag reroutes holdout-phase calls to holdout labels. Everything lives on `run_json` (checkpoints/resume free); a `cost_breakdown` event feeds the CLI collector.

**Tech Stack:** existing stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-cost-breakdown-design.md`.

## Global Constraints

- Commit messages: NEVER add attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` suffixes; strict TS; after every task `npx vitest run` green AND bare `npm run type-check` (never piped).
- Breakdown purpose keys are EXACTLY the `COST_LABELS` values; per-model keys are `model:<provider>/<model>`.
- Invariant: summing purpose entries reproduces `run.totals` exactly (usd, calls, both token counts); model entries sum identically.
- Repo files are CRLF — scripted regex edits need `\r?\n`.
- Work on branch `cost-breakdown` off `master`.

---

### Task 1: COST_LABELS + accrueCost + full engine accounting

**Files:**
- Modify: `packages/core/src/engine/estimate.ts` (export COST_LABELS, use them in `add(...)` calls)
- Modify: `packages/core/src/types.ts` (`EvaluationRun.costBreakdown` + `.estimate`)
- Modify: `packages/core/src/engine/evaluator_v2.ts` (accrueCost, seven site replacements, costContext, cost_breakdown event)
- Test: `packages/core/tests/engine/cost-breakdown.test.ts` (new), extend `packages/core/tests/engine/resume-e2e.test.ts`

**Interfaces:**
- Produces:
  - `export const COST_LABELS = { fill: 'Population fill (mutations)', candidates: 'Candidate evaluations', grading: 'LLM grading', safety: 'Safety guardrails', stability: 'Stability re-runs', operators: 'Genetic operators', playoff: 'Pairwise playoffs', holdout: 'Holdout evaluation', holdoutGrading: 'Holdout grading' } as const;` (estimate.ts)
  - `EvaluationRun.costBreakdown?: Record<string, { calls: number; promptTokens: number; completionTokens: number; usd: number }>;`
  - `EvaluationRun.estimate?: { calls: number; low: number; high: number; breakdown: Array<{ label: string; calls: number; low: number; high: number }> };`
  - Event `{ type: 'cost_breakdown', breakdown, estimate }` emitted in `finishEvaluation` before the finished status.
  - `EvaluationState.costContext: 'evolution' | 'holdout'`.

- [ ] **Step 1: Failing E2E** — `packages/core/tests/engine/cost-breakdown.test.ts` (fidelity harness: store mock, registry, tmp DB, deep-snapshot event capture — same scaffolding as `pairwise-e2e.test.ts`). Config: initialSize 2, generationSize 2, maxGenerations 2, seed 42, mutationShare 1, `pairwise: { enabled: true, contenders: 2 }`, testSet = 1 llm_grade fitness test + 1 exact_match holdout test (`holdout: true`), deterministic omni adapter (same discriminators as pairwise-e2e: winner/Rubric/mutations/apply/echo). Assertions after finish:

```ts
    const finalRun = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
    const bd = finalRun.costBreakdown;
    expect(bd).toBeDefined();

    const purposes = Object.keys(bd).filter(k => !k.startsWith('model:'));
    const models = Object.keys(bd).filter(k => k.startsWith('model:'));
    // Expected labels for this config — and NO others
    expect(purposes.sort()).toEqual([
      'Candidate evaluations', 'Genetic operators', 'Holdout evaluation',
      'LLM grading', 'Pairwise playoffs', 'Population fill (mutations)',
    ].sort());
    expect(models).toEqual(['model:omni/m1']);

    // Invariant: purpose sums == totals exactly; model sums identical
    const sum = (keys: string[], f: string) => keys.reduce((a, k) => a + bd[k][f], 0);
    for (const f of ['usd', 'calls', 'promptTokens', 'completionTokens']) {
      expect(sum(purposes, f)).toBeCloseTo(finalRun.totals[f === 'promptTokens' ? 'tokensPrompt' : f === 'completionTokens' ? 'tokensCompletion' : f], 10);
      expect(sum(models, f)).toBeCloseTo(sum(purposes, f), 10);
    }

    // Holdout calls tagged separately (holdout test is exact_match => no Holdout grading here)
    expect(bd['Holdout evaluation'].calls).toBe(2); // champion + seed × 1 test × 1 sample

    // Event emitted before finished, carrying the breakdown
    const bdEventIdx = events.findIndex(e => e.type === 'cost_breakdown');
    const finIdx = events.findIndex(e => e.type === 'status' && e.status === 'finished');
    expect(bdEventIdx).toBeGreaterThan(-1);
    expect(bdEventIdx).toBeLessThan(finIdx);
    expect(events[bdEventIdx].breakdown['Candidate evaluations'].calls).toBeGreaterThan(0);
```

(Full file: clone the pairwise-e2e scaffolding — omni adapter, config/run insert, event capture with `JSON.parse(JSON.stringify(...))`, `beforeEach(resetRegistry)`; keep `db` open until after reading run_json, then `closeDatabase()`.)

- [ ] **Step 2: Verify failure** (no costBreakdown, no event).

- [ ] **Step 3: estimate.ts** — add the `COST_LABELS` export (exact object above, placed right after the `CostEstimate` interface) and replace the nine string literals in `add('...')` calls with `COST_LABELS.fill`, `.candidates`, `.grading`, `.safety`, `.stability`, `.operators`, `.playoff`, `.holdout`, `.holdoutGrading`. Estimate unit tests must stay green untouched (labels are byte-identical). Export from index.ts: `export { COST_LABELS } from './engine/estimate.js';` next to the estimateRunCost export.

- [ ] **Step 4: types.ts** — the two `EvaluationRun` fields (after `playoffs`).

- [ ] **Step 5: evaluator_v2.ts**

5a. Import `COST_LABELS` from `./estimate.js`. `EvaluationState` gains `costContext: 'evolution' | 'holdout';`, initialized `'evolution'` in the state literal.
5b. Helper (near `persistRun`):
```ts
/** Single accounting path: totals + per-purpose + per-model breakdown together. */
function accrueCost(
  state: EvaluationState,
  purpose: string,
  model: ModelRef,
  c: { usd: number; promptTokens: number; completionTokens: number; calls: number },
): void {
  state.run.totals.usd += c.usd;
  state.run.totals.tokensPrompt += c.promptTokens;
  state.run.totals.tokensCompletion += c.completionTokens;
  state.run.totals.calls += c.calls;
  const bd = (state.run.costBreakdown ??= {});
  for (const key of [purpose, `model:${model.provider}/${model.model}`]) {
    const rec = (bd[key] ??= { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 });
    rec.calls += c.calls;
    rec.promptTokens += c.promptTokens;
    rec.completionTokens += c.completionTokens;
    rec.usd += c.usd;
  }
}
```
(`ModelRef` may need adding to the type imports.)
5c. Replace the seven totals blocks (grep `totals.usd +=` — current lines noted):
  - fill (~343-346): `accrueCost(state, COST_LABELS.fill, state.config.serviceModel, { usd: result.cost.usd, promptTokens: result.cost.promptTokens, completionTokens: result.cost.completionTokens, calls: result.cost.calls });`
  - safety (~616-619): `accrueCost(state, COST_LABELS.safety, state.config.serviceModel, { usd: safetyResult.totalCost, promptTokens: safetyResult.totalPromptTokens, completionTokens: safetyResult.totalCompletionTokens, calls: safetyResult.calls });`
  - stability (~646-649): `accrueCost(state, COST_LABELS.stability, node.params.model, { usd: stabilityResult.totalCost, promptTokens: stabilityResult.totalPromptTokens, completionTokens: stabilityResult.totalCompletionTokens, calls: stabilityResult.calls });`
  - candidate sample (~852-855): `accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdout : COST_LABELS.candidates, params.model, { usd: result.usd, promptTokens: result.promptTokens, completionTokens: result.completionTokens, calls: 1 });`
  - grading (~904-907): `accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdoutGrading : COST_LABELS.grading, state.config.serviceModel, { usd: gradingResult.usd, promptTokens: gradingResult.promptTokens, completionTokens: gradingResult.completionTokens, calls: 1 });`
  - playoff accrue callback (~1054-1058): body becomes `accrueCost(state, COST_LABELS.playoff, state.config.serviceModel, { usd, promptTokens, completionTokens, calls: 1 });` followed by the existing totals sendUpdate.
  - operators (~1115-1118): `accrueCost(state, COST_LABELS.operators, state.config.serviceModel, { usd: result.costTracking.usd, promptTokens: result.costTracking.promptTokens, completionTokens: result.costTracking.completionTokens, calls: result.costTracking.calls });`
  Each replacement preserves the adjacent `totals` sendUpdate lines exactly as they are.
5d. `runHoldoutEvaluation`: wrap its body's evaluation section with `state.costContext = 'holdout'; try { ...existing evaluatePromptOnTests calls... } finally { state.costContext = 'evolution'; }` (set it before the champion/seed evaluations, restore after).
5e. `finishEvaluation`: before the `status: 'finished'` sendUpdate, add
```ts
  sendUpdate(runId, { type: 'cost_breakdown', breakdown: state.run.costBreakdown, estimate: state.run.estimate });
```

- [ ] **Step 6: resume E2E extension** — in `resume-e2e.test.ts`'s truncated-run test, after the resumed run finishes, add:
```ts
    const rbd = resumed.costBreakdown;
    expect(rbd).toBeDefined();
    const rp = Object.keys(rbd).filter(k => !k.startsWith('model:'));
    expect(rp.reduce((a, k) => a + rbd[k].usd, 0)).toBeCloseTo(resumed.totals.usd, 10);
```
(The truncated fixture cloned from `full` already carries `full.costBreakdown` — resume must keep accumulating on top of it, and the invariant must still hold at the end.)

- [ ] **Step 7: Run** — new E2E green; resume/seed/pairwise/checkpoint suites green; estimate unit tests green; full suite; bare type-check.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/engine/estimate.ts packages/core/src/types.ts packages/core/src/engine/evaluator_v2.ts packages/core/src/index.ts packages/core/tests/engine/cost-breakdown.test.ts packages/core/tests/engine/resume-e2e.test.ts
git commit -m "Categorized cost accounting: accrueCost + per-purpose/per-model breakdown"
```

---

### Task 2: Schema v4 — drop cost_ledger

**Files:**
- Modify: `packages/core/src/database/init.ts` (remove the CREATE block at ~275-289; migration 4; fresh-install version 4)
- Modify: `apps/desktop/electron/ipc/handlers.ts` (remove the `DELETE FROM cost_ledger WHERE run_id = ?` line at ~278)
- Test: extend `packages/core/tests/database/wrapper.test.ts` (or the init-path test file — whichever already exercises `runMigrations`; if neither does, add the case to `wrapper.test.ts`)

- [ ] **Step 1: Failing test**:

```ts
  it('migration 4 drops the legacy cost_ledger table', async () => {
    // Build a v3-shaped DB that still has the legacy table
    const dbPath = path.join(os.tmpdir(), `pe-mig4-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(dbPath);
    let db = getDatabase();
    db.exec('CREATE TABLE IF NOT EXISTS cost_ledger (id INTEGER PRIMARY KEY, run_id TEXT)');
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (3)').run();
    closeDatabase();

    await initializeDatabase(dbPath); // reopen => migrations run
    db = getDatabase();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_ledger'").get();
    expect(table).toBeUndefined();
    const v = db.prepare('SELECT version FROM schema_version').get() as any;
    expect(v.version).toBe(4);
    closeDatabase();
    fs.rmSync(dbPath, { force: true });
  });
```
(Match the surrounding file's import style; the wrapper test file already imports initializeDatabase/getDatabase/closeDatabase or add them.)

- [ ] **Step 2: Verify failure** (fresh install still writes v3; no migration 4).

- [ ] **Step 3: Implement** — delete the `CREATE TABLE IF NOT EXISTS cost_ledger` block; fresh-install branch: `VALUES (4)` + log text `(schema v4)`; after migration 3 add:
```ts
  // Migration 4: Drop the never-written cost_ledger table (cost accounting
  // now lives on run_json as costBreakdown)
  if (version === 3) {
    console.log('Running migration 4: Dropping legacy cost_ledger table...');
    db.exec('DROP TABLE IF EXISTS cost_ledger');
    setVersion(4);
    console.log('Migration 4 completed');
    version = 4;
  }
```
Desktop handlers.ts: remove the single `db.prepare('DELETE FROM cost_ledger WHERE run_id = ?').run(runId);` line.

- [ ] **Step 4: Run** — migration test green; ALL tests that open fresh DBs still green (they now initialize at v4); desktop handlers tests green; bare type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/database/init.ts apps/desktop/electron/ipc/handlers.ts packages/core/tests/database/wrapper.test.ts
git commit -m "Schema v4: drop never-written cost_ledger table"
```

---

### Task 3: CLI stamping, collector, report table, docs

**Files:**
- Modify: `packages/cli/src/engine.ts` (stamp `run.estimate`; collector case + EvolutionResult fields)
- Modify: `packages/cli/src/report.ts` ("Where the money went")
- Modify: `docs/cli.md`, `.claude/skills/evolving-prompts/SKILL.md`

- [ ] **Step 1: Stamp** — in the fresh-run banner block (inside the existing try, after the warnings loop): `run.estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };` (the run INSERT below then persists it; `startEvaluation`'s `{ ...run }` spread carries it — verify nothing rebuilds the run literal field-by-field).
- [ ] **Step 2: Collector** — `RunCollector` gains `costBreakdown: EvaluationRun['costBreakdown'] | null; estimate: EvaluationRun['estimate'] | null;` (init `null` in `createCollector`); switch gains:
```ts
      case 'cost_breakdown':
        collector.costBreakdown = data.breakdown ?? null;
        collector.estimate = data.estimate ?? null;
        break;
```
`EvolutionResult` gains `costBreakdown?: EvaluationRun['costBreakdown']; estimate?: EvaluationRun['estimate'];`; `buildResult` includes `...(collector.costBreakdown ? { costBreakdown: collector.costBreakdown } : {}), ...(collector.estimate ? { estimate: collector.estimate } : {}),`.
- [ ] **Step 3: Report** — after the Run Configuration table section, insert:
```ts
  // ---- Where the money went ----
  if (result.costBreakdown) {
    lines.push('## Where the money went');
    lines.push('');
    if (result.estimate) {
      lines.push(`*Estimated: $${result.estimate.low.toFixed(4)} – $${result.estimate.high.toFixed(4)} (~${result.estimate.calls} calls) · Actual: $${result.totals.usd.toFixed(4)} (${result.totals.calls} calls)*`);
      lines.push('');
    }
    const estByLabel = new Map((result.estimate?.breakdown ?? []).map(b => [b.label, b]));
    const purposes = Object.keys(result.costBreakdown).filter(k => !k.startsWith('model:'));
    const allLabels = [...new Set([...purposes, ...estByLabel.keys()])];
    lines.push('| Purpose | Est. calls | Calls | Est. $ | Actual $ |');
    lines.push('|---|---|---|---|---|');
    for (const label of allLabels) {
      const act = result.costBreakdown[label];
      const est = estByLabel.get(label);
      lines.push(`| ${label} | ${est ? est.calls : '—'} | ${act ? act.calls : '—'} | ${est ? `$${est.low.toFixed(4)}–$${est.high.toFixed(4)}` : '—'} | ${act ? `$${act.usd.toFixed(4)}` : '—'} |`);
    }
    const models = Object.keys(result.costBreakdown).filter(k => k.startsWith('model:'));
    if (models.length > 0) {
      lines.push('');
      lines.push('**By model:** ' + models.map(m => `${m.slice(6)} $${result.costBreakdown![m].usd.toFixed(4)} (${result.costBreakdown![m].calls} calls)`).join(', '));
    }
    lines.push('');
  }
```
- [ ] **Step 4: Docs** — `docs/cli.md`, after the Cost estimation paragraph: `results.json also carries the ACTUAL spend split by purpose and by model (\`costBreakdown\`) plus the stamped preflight \`estimate\` — the report's "Where the money went" table shows them side by side. If judge spend ("LLM grading"/"Pairwise playoffs") dominates, pick a cheaper \`serviceModel\`.` SKILL.md bullet in Reading results: `- \`costBreakdown\` in results.json splits actual spend by purpose (and \`model:*\` keys by model) — if LLM grading or playoffs dominate, cheapen \`serviceModel\`, not the candidates.`
- [ ] **Step 5: Run** — CLI + full suite; bare type-check.
- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/engine.ts packages/cli/src/report.ts docs/cli.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI: estimate stamping, costBreakdown in results, money-went report table"
```

---

### Task 4: Desktop stamping + store case

**Files:**
- Modify: `apps/desktop/electron/ipc/handlers.ts` (`eval:create` stamps `run.estimate`)
- Modify: `apps/desktop/src/store/evaluationStore.ts` (silent `cost_breakdown` case)
- Test: extend `apps/desktop/tests/ipc/handlers.test.ts`

- [ ] **Step 1: Failing test** — in the CRUD round-trip test after `eval:create`: `expect(run.estimate?.calls).toBeGreaterThan(0);` (makeConfig has models + tests, so an estimate must stamp; models may be uncatalogued in the test DB — calls still > 0, only prices are $0).
- [ ] **Step 2: Implement** — in the `eval:create` flow where the run object is built (before the INSERT):
```ts
  try {
    const { estimateRunCost, getModelCost } = await import('@promptengine/core');
    const est = await estimateRunCost(config, getModelCost);
    (run as any).estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };
  } catch (error) {
    console.warn('[IPC] estimate stamping failed (non-fatal):', error);
  }
```
evaluationStore.ts subscribe switch: `case 'cost_breakdown': break; // persisted on run_json; no live UI yet`.
- [ ] **Step 3: Run** — desktop tests green; bare type-check; rebuild `npm run build:dev -w apps/desktop`.
- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/ipc/handlers.ts apps/desktop/src/store/evaluationStore.ts apps/desktop/tests/ipc/handlers.test.ts
git commit -m "Desktop: stamp preflight estimate on created runs"
```

---

### Task 5: Live verification

**Files:** none committed (scratchpad only).

- [ ] **Step 1**: Real flash-lite run (reuse the seed-live config with `--output`): assert results.json has `estimate` (stamped band) and `costBreakdown`; purpose sums equal `totals` exactly (node one-liner); actual usd inside the stamped `[low, high]` (it's the calibrated estimator).
- [ ] **Step 2**: Report shows "Where the money went" with the estimated-vs-actual header line, per-label rows, and the By-model line.
- [ ] **Step 3**: Report numbers; any invariant violation → STOP and diagnose the accrual site that leaked.
