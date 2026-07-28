# Checkpointing + Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interrupted runs lose nothing — every node/generation checkpoints to the DB as it completes, and `--resume <runId>` (CLI) / a Resume button (desktop) continues from the checkpoint with cumulative budget enforcement.

**Architecture:** A `persistRun` helper (the UPDATE that today only `finishEvaluation` performs) fires at node-terminal, fill-complete, generation, playoff, holdout, and pause boundaries. `startEvaluation` detects a loaded run by `run.generations.length > 0` and rebuilds state instead of creating a shell population: terminal nodes keep scores and re-seed the cache, non-terminal nodes re-queue, interrupted gen-0 fills re-run through their original seeded streams, and existing nodes replay to the host as `node_created` events (which rebuilds the CLI collector and desktop UI for free). Desktop resume reuses the existing `eval:start` handler, which already loads `run_json` from the DB.

**Tech Stack:** existing stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-resume-interrupted-runs-design.md`. Correction to spec: terminal node statuses in this codebase are `'finished' | 'failed' | 'skipped'` (see `evaluationLoop` allFinished check), not "error".

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By`/attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` suffixes; strict TS; after every task: `npx vitest run` green AND `npm run type-check` (run bare, never piped into tail/grep — a pipe masks its exit code; that bit us in the seed phase).
- Checkpoint failures must never kill a run (persistRun catches and logs).
- Fresh-run behavior must be byte-identical when not resuming (fresh runs arrive with `generations: []`).
- Work on branch `resume-runs` off `master`.

---

### Task 1: persistRun checkpoints + computeCacheKey + isEvaluationActive

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts`
- Modify: `packages/core/src/index.ts` (export `isEvaluationActive`)
- Test: `packages/core/tests/engine/checkpoint.test.ts` (new)

**Interfaces:**
- Produces: `function persistRun(state: EvaluationState): void` (module-private); `function computeCacheKey(node: CandidateNode, state: EvaluationState): string` (module-private, extracted from runTests); `export function isEvaluationActive(runId: UUID): boolean`.

- [ ] **Step 1: Failing test** — `packages/core/tests/engine/checkpoint.test.ts` (fidelity-harness scaffolding):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation, isEvaluationActive } from '../../src/engine/evaluator_v2.js';

function registerEcho() {
  registerProvider({ adapter: { name: 'ck', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const p: string = opts.prompt;
      if (p.includes('mutations to improve')) return { output: '[{"label":"MUTATION","edit":"x"}]', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
      if (p.includes('Produce the NEW prompt ONLY')) return { output: 'CHILD PROMPT', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
      return { output: opts.system ?? p, promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
    } } as any });
}

const config = {
  id: 'ck-cfg', name: 'checkpoint',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'CK SEED', fill: 'auto' },
  enabledModels: [{ provider: 'ck', model: 'm' }],
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 2 },
  serviceModel: { provider: 'ck', model: 'm' },
  parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
} as any;

beforeEach(() => resetRegistry());

describe('run checkpointing', () => {
  it('persists run_json at node/generation boundaries, not just at finish', async () => {
    registerEcho();
    const tmpDb = path.join(os.tmpdir(), `pe-ck-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = { id: 'ck-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    // Capture every UPDATE payload by wrapping db.prepare
    const snapshots: any[] = [];
    const origPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('UPDATE evaluation_runs')) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: any[]) => { snapshots.push(JSON.parse(args[0])); return origRun(...args); };
      }
      return stmt;
    };

    const done = new Promise<void>(res => setSendUpdate((_id, d) => {
      if (d.type === 'status' && d.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    expect(isEvaluationActive(run.id)).toBe(true);
    await done;

    // Multiple checkpoints, and at least one MID-RUN (status running with >=1 finished node)
    expect(snapshots.length).toBeGreaterThan(2);
    const midRun = snapshots.filter(s => s.status === 'running' && s.generations.flat().some((n: any) => n.status === 'finished'));
    expect(midRun.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1].status).toBe('finished');
    expect(isEvaluationActive(run.id)).toBe(false);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 30000);
});
```

Note: `isEvaluationActive(run.id)` right after `startEvaluation` returns is true because the state stays registered until finish; after `done` it must be false — check how `finishEvaluation` cleans up (`activeEvaluations.delete`); if it doesn't delete, add the delete there (it should already — verify).

- [ ] **Step 2: Run to verify failure** — only ONE snapshot (the finish) today, and `isEvaluationActive` doesn't exist.

- [ ] **Step 3: Implement in `evaluator_v2.ts`**

3a. Top of file: `import { createHash } from 'crypto';`
3b. Add module-privates near `finishEvaluation`:
```ts
/** Checkpoint the run so an interrupted process loses nothing. Never throws. */
function persistRun(state: EvaluationState): void {
  try {
    const db = getDatabase();
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?
      WHERE id = ?
    `).run(JSON.stringify(state.run), state.run.id);
  } catch (error) {
    console.error('[Evaluator] Checkpoint persist failed:', error);
  }
}
```
3c. Extract cache key (replace the inline block in `runTests` that does `await import('crypto')`):
```ts
function computeCacheKey(node: CandidateNode, state: EvaluationState): string {
  const testSetSig = state.fitnessTests.map(t => t.id).join(',');
  return createHash('sha256')
    .update(`${node.prompt}|${node.params.model.provider}/${node.params.model.model}|${node.params.temperature}|${state.promptMode}|${state.samplesPerTest}|${testSetSig}`)
    .digest('hex');
}
```
`runTests` becomes `const cacheKey = computeCacheKey(node, state);` (drop the crypto dynamic import and testSetSig lines).
3d. `finishEvaluation`: replace its inline `db.prepare(UPDATE...)` block with `persistRun(state);` (status/finishedAt assignments above it stay).
3e. Checkpoint call sites (each is one line, `persistRun(state);`):
  - end of `processNode`, after the final `node_updated` send (after the `if (!skipFinalUpdate) {...}` block);
  - in `mutatePopulationInBackground`, right after `console.log('[Evaluator] All mutations complete')`;
  - end of `moveToNextGeneration`, after the `generation_created` sendUpdate;
  - in `maybeRunPlayoff`, after the `playoff_result` sendUpdate;
  - in `runHoldoutEvaluation`, just before it returns (after `holdout_result` is sent);
  - both pause-completion sites (the two blocks that set `state.run.status = 'paused'` and send the paused status — one in `evaluationLoop`, one in `mutatePopulationInBackground`).
3f. Export:
```ts
export function isEvaluationActive(runId: UUID): boolean {
  return activeEvaluations.has(runId);
}
```
and in `packages/core/src/index.ts` add `isEvaluationActive` to the evaluator exports line.
3g. Verify `finishEvaluation` (or its caller) deletes from `activeEvaluations`; if not, add `activeEvaluations.delete(runId);` at its end.

- [ ] **Step 4: Run** — checkpoint test green; full suite green; `npm run type-check` (bare).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/src/index.ts packages/core/tests/engine/checkpoint.test.ts
git commit -m "Checkpoint run_json at node, generation, playoff, holdout, and pause boundaries"
```

---

### Task 2: Resume path in startEvaluation

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts` (resume branch, fill filter change)
- Test: `packages/core/tests/engine/resume-e2e.test.ts` (new)

**Interfaces:**
- Consumes: `persistRun`, `computeCacheKey` (Task 1).
- Produces: `startEvaluation(runId, config, run)` resumes when `run.generations.length > 0`; throws `Run <id> is already finished` for finished runs; replays existing nodes as `node_created` + a `totals` event before continuing.

- [ ] **Step 1: Failing tests** — `packages/core/tests/engine/resume-e2e.test.ts`. Uses a deterministic adapter and a seeded config so the resumed run must equal an uninterrupted one:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';

let evalPrompts: string[] = []; // candidate prompts the adapter actually evaluated

function registerDet() {
  registerProvider({ adapter: { name: 'det', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
      const p: string = opts.prompt;
      if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
      if (p.includes('Produce the NEW prompt ONLY')) {
        let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
        return { ...base, output: `PROMPT-${(h >>> 0).toString(36)}` };
      }
      evalPrompts.push(opts.system ?? '');
      return { ...base, output: opts.system ?? p };
    } } as any });
}

const CONFIG = {
  id: 'rs-cfg', name: 'resume e2e',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 3, generationSize: 3, seedPrompt: 'RS SEED', fill: 'auto' },
  enabledModels: [{ provider: 'det', model: 'm' }],
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 3 },
  serviceModel: { provider: 'det', model: 'm' },
  parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  seed: 42,
} as any;

function decisionSignature(run: any) {
  return run.generations.map((g: any[]) => g.map(n => ({
    prompt: n.prompt, label: n.changeLog?.[0]?.label, temp: n.params?.temperature, nodeSeed: n.params?.seed,
  })));
}

async function runToCompletion(run: any, opts: { fresh?: boolean } = {}): Promise<any> {
  const tmpDb = path.join(os.tmpdir(), `pe-rs-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
  let finalRun: any;
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(run.id, CONFIG, run);
  await done;
  finalRun = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  void opts;
  return finalRun;
}

const freshRun = () => ({ id: 'rs-run-' + Math.random().toString(36).slice(2), configId: CONFIG.id, startedAt: Date.now(),
  totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' });

beforeEach(() => { resetRegistry(); evalPrompts = []; });

describe('resume from checkpoint', () => {
  it('a truncated run resumes to the same decision signature as an uninterrupted one, without re-evaluating finished nodes', async () => {
    registerDet();
    const full = await runToCompletion(freshRun());
    const fullSig = decisionSignature(full);
    expect(full.generations.length).toBe(3);

    // Build the "crashed at gen 1" state from the completed run: drop gen 2,
    // and reset two of gen 1's nodes to awaiting (keep one finished).
    const truncated = JSON.parse(JSON.stringify(full));
    truncated.id = 'rs-resumed';
    truncated.status = 'running';
    delete truncated.finishedAt; delete truncated.stopReason;
    truncated.generations = truncated.generations.slice(0, 2);
    const gen1 = truncated.generations[1];
    const keptFinishedPrompt = gen1[0].prompt;
    for (const n of gen1.slice(1)) { n.status = 'running'; delete n.tests; delete n.metrics; }
    // Recompute totals to the checkpoint level (subtract nothing — totals at crash
    // are whatever was accrued; use the full run's totals minus a fake delta is
    // unnecessary: keep them as-is, resume only needs to GROW from here)
    const baseUsd = truncated.totals.usd;

    resetRegistry(); registerDet(); evalPrompts = [];
    const resumed = await runToCompletion(truncated);

    expect(resumed.status).toBe('finished');
    expect(resumed.generations.length).toBe(3);
    expect(decisionSignature(resumed)).toEqual(fullSig); // seeded resume == uninterrupted run
    expect(resumed.totals.usd).toBeGreaterThan(baseUsd); // spend accumulated, not reset

    // Finished nodes were NOT re-evaluated: gen 0 prompts and the kept gen-1 node
    // never hit the adapter again (cache may also shield them — either way, no calls)
    expect(evalPrompts).not.toContain(keptFinishedPrompt);
    for (const n of full.generations[0]) expect(evalPrompts).not.toContain(n.prompt);
  }, 60000);

  it('refuses to resume a finished run', async () => {
    registerDet();
    const full = await runToCompletion(freshRun());
    const again = JSON.parse(JSON.stringify(full));
    const tmpDb = path.join(os.tmpdir(), `pe-rs-fin-${process.pid}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(again.id, again.configId, again.startedAt, JSON.stringify(again), again.version);
    await expect(startEvaluation(again.id, CONFIG, again)).rejects.toThrow(/already finished/);
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  }, 60000);

  it('resumes a run interrupted during the initial fill (pending gen-0 mutations)', async () => {
    registerDet();
    // Gen 0 as checkpointed mid-fill: baseline awaiting, two nodes still waiting for mutation
    const run: any = freshRun();
    run.status = 'running';
    run.generations = [[
      { id: 'n0', generation: 0, lineageParents: [], status: 'awaiting', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 1 },
        changeLog: [{ label: 'MUTATION', text: 'Seed prompt (baseline)' }] },
      { id: 'n1', generation: 0, lineageParents: [], status: 'pending', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 2 },
        changeLog: [{ label: 'MUTATION', text: 'Waiting for mutation...' }] },
      { id: 'n2', generation: 0, lineageParents: [], status: 'running', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 3 },
        changeLog: [{ label: 'MUTATION', text: 'Waiting for mutation...' }] },
    ]];
    const resumed = await runToCompletion(run);
    expect(resumed.status).toBe('finished');
    // Both waiting nodes got real mutations (changelog no longer the placeholder)
    const gen0 = resumed.generations[0];
    expect(gen0.filter((n: any) => n.changeLog?.[0]?.text === 'Waiting for mutation...').length).toBe(0);
    expect(gen0.every((n: any) => n.status === 'finished')).toBe(true);
    expect(resumed.generations.length).toBe(3);
  }, 60000);
});
```

- [ ] **Step 2: Run to verify failure** — today `startEvaluation` wipes `generations` to `[[]]` and builds a fresh shell population; the first test fails on signature/length, the second doesn't throw.

- [ ] **Step 3: Implement the resume branch**

3a. At the top of `startEvaluation`, after the `activeEvaluations.has` guard:
```ts
  const isResume = run.generations.length > 0;
  if (isResume && run.status === 'finished') {
    throw new Error(`Run ${runId} is already finished`);
  }
```
3b. State init: `generations: isResume ? run.generations : [[]]` in the `run: { ...run, ... }` literal (status stays `'running'`).
3c. After `activeEvaluations.set(runId, state)` and the running-status sendUpdate, insert the resume branch (fresh path continues unchanged below it):
```ts
  if (isResume) {
    state.currentGeneration = state.run.generations.length - 1;
    state.run.stopReason = undefined;
    const TERMINAL = new Set(['finished', 'failed', 'skipped']);
    let kept = 0, requeued = 0, refill = 0;
    for (const gen of state.run.generations) {
      for (const node of gen) {
        if (TERMINAL.has(node.status)) {
          if (node.status === 'finished' && node.tests?.length) {
            state.cache.set(computeCacheKey(node, state), node.tests);
          }
          kept++;
        } else if (node.generation === 0 && node.changeLog?.[0]?.text === 'Waiting for mutation...') {
          node.status = 'pending';
          node.tests = undefined; node.metrics = undefined; node.error = undefined;
          refill++;
        } else {
          node.status = 'awaiting';
          node.tests = undefined; node.metrics = undefined; node.error = undefined;
          requeued++;
        }
      }
    }
    console.log(`[Evaluator] Resuming from generation ${state.currentGeneration}: ${kept} kept, ${requeued} re-queued, ${refill} pending fill, $${state.run.totals.usd.toFixed(4)} already spent`);

    // Replay existing state to the host (rebuilds CLI collector / desktop UI)
    for (const gen of state.run.generations) {
      for (const node of gen) sendUpdate(runId, { type: 'node_created', node });
    }
    sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });

    if (state.run.generations[0].some(n => n.status === 'pending')) {
      // Interrupted during initial fill — the fill path re-mutates pending nodes,
      // then queues gen 0 and starts the loop
      mutatePopulationInBackground(runId, state);
    } else {
      state.queue = state.run.generations[state.currentGeneration].filter(n => n.status === 'awaiting');
      console.log(`[Evaluator] Resume queue: ${state.queue.length} nodes`);
      evaluationLoop(runId);
    }
    console.log(`[Evaluator] startEvaluation returning (resume)`);
    return;
  }
```
3d. `mutatePopulationInBackground` fill selection becomes status-based (fresh behavior identical — freshly created non-baseline shell nodes are `'pending'`), and the rng label becomes the node's stable gen-0 index:
```ts
  const nodesToMutate = shellNodes.filter(n => n.status === 'pending');
```
and inside the map callback (drop the `k` param):
```ts
      const gen0Index = shellNodes.indexOf(node); // stable across resume — keeps the 'fill' stream label
      const result = await mutateNode(shellNodes[0].prompt, state.config, rngFor(state.config.seed, 'fill', gen0Index));
```
(For fresh runs `gen0Index === k + 1` exactly as before — the seeded fill streams are unchanged; the seed E2E from the reproducibility phase must stay green untouched.)

- [ ] **Step 4: Run** — resume tests green; `packages/core/tests/engine/seed-e2e.test.ts` and the full suite green; `npm run type-check` bare.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/tests/engine/resume-e2e.test.ts
git commit -m "Resume interrupted runs from checkpoint in startEvaluation"
```

---

### Task 3: CLI --resume

**Files:**
- Modify: `packages/cli/src/engine.ts` (`RunEvolutionOptions.existingRun`, skip inserts, resume banner)
- Modify: `packages/cli/src/index.ts` (`--resume` flag, `handleResumeRun`)
- Modify: `docs/cli.md` (usage line + "Resuming interrupted runs" section), `.claude/skills/evolving-prompts/SKILL.md` (one bullet)
- Test: covered by engine E2E (Task 2) + live (Task 5); CLI-level: extend `packages/cli/tests/config.test.ts` only if an exported unit is touched (none — arg parsing stays unexported, verified live).

- [ ] **Step 1: engine.ts** — add `existingRun?: EvaluationRun;` to the `RunEvolutionOptions` interface. In `runEvolution`:
  - `const run: EvaluationRun = options?.existingRun ?? { ...current literal... };` and `const runId = run.id;` (replace the current fresh-uuid usage accordingly).
  - Wrap the config INSERT retry loop AND the run INSERT in `if (!options?.existingRun) { ... }` (the config row already exists for a resumed run; `config.id`/`run.configId` reassignment also stays inside the guard).
  - Banner: in the resumed case print instead:
```ts
    const finishedCount = run.generations.flat().filter(n => n.status === 'finished').length;
    process.stderr.write(`Resuming run ${run.id.slice(0, 8)} from generation ${run.generations.length - 1} (${finishedCount} finished nodes, $${run.totals.usd.toFixed(4)} already spent)\n\n`);
```
  (collector needs no pre-seeding: the engine's resume replay emits `node_created` for every historical node and a `totals` event, which the existing collector cases already ingest).

- [ ] **Step 2: index.ts** —
  - parse-args: return type gains `resume?: string;`, result literal gains `resume: undefined as string | undefined,`, switch gains:
```ts
      case '--resume':
        result.resume = args[++i];
        if (!result.resume) { console.error('--resume requires a run id'); process.exit(1); }
        break;
```
  - help text under `--config`: `  --resume <runId>             Resume an interrupted run from its checkpoint`
  - main dispatch, BEFORE the `if (args.config)` branch:
```ts
  if (args.resume) {
    await handleResumeRun(args.resume, args.config, args.output, args.db, args.pluginDirs);
    return;
  }
```
  - new handler (mirror `handleRunEvolution`'s structure; reuse its output/report tail by extracting the shared post-run block into `async function emitOutputs(result: EvolutionResult, evalConfig: EvaluationConfig, cliConfig: CliConfig | undefined, outputPath?: string)` if the tail is more than ~15 lines, otherwise duplicate the small tail):
```ts
async function handleResumeRun(runId: string, configPath?: string, outputPath?: string, dbPath?: string, pluginDirs: string[] = []): Promise<void> {
  // Optional --config re-supplies file-based extras: keys, systemPrompts, plugins
  const cliConfig = configPath ? loadCliConfig(configPath) : undefined;
  installStoreShim(cliConfig ? extractConfigKeys(cliConfig) : {}, cliConfig?.systemPrompts);

  const pathMod = await import('path');
  if ((cliConfig?.plugins?.length ?? 0) > 0 || pluginDirs.length > 0) {
    const configDir = configPath ? pathMod.dirname(pathMod.resolve(configPath)) : process.cwd();
    const { loadCliPlugins } = await import('./plugins.js');
    await loadCliPlugins({ configDir, configPlugins: cliConfig?.plugins ?? [], flagDirs: pluginDirs });
  }

  await initCliDatabase(dbPath);
  const { getDatabase } = await import('@promptengine/core');
  const db = getDatabase();
  const row = db.prepare('SELECT run_json, config_id FROM evaluation_runs WHERE id = ?').get(runId) as { run_json: string; config_id: string } | undefined;
  if (!row) { console.error(`Run not found: ${runId}`); process.exit(1); }
  const run = JSON.parse(row.run_json);
  if (run.status === 'finished') { console.error(`Run ${runId} is already finished — nothing to resume. Reseed a new run from its best prompt instead.`); process.exit(1); }
  const cfgRow = db.prepare('SELECT config_json FROM evaluation_configs WHERE id = ?').get(row.config_id) as { config_json: string } | undefined;
  if (!cfgRow) { console.error(`Config not found for run: ${row.config_id}`); process.exit(1); }
  const evalConfig = JSON.parse(cfgRow.config_json);

  // Same key preflight as a fresh run
  ...copy the requiredProviders/resolveApiKey loop from handleRunEvolution verbatim, using cliConfig-derived keys when present...

  const result = await runEvolution(evalConfig, { existingRun: run });
  ...same result/report/exit-code tail as handleRunEvolution (extracted or duplicated)...
}
```
  Where `handleRunEvolution`'s tail references `cliConfig`, the resume path passes its (possibly undefined) `cliConfig` — `generateReport(result, evalConfig, cliConfig)` accepts what it gets today; check its signature and pass a minimal `{ seedPrompt: evalConfig.population.seedPrompt, testSet: [] } as any` ONLY if it requires a defined cliConfig (prefer making the param optional).

- [ ] **Step 3: Docs** — `docs/cli.md` usage block gains the `--resume` line; new section after "Evaluation fidelity":
```markdown
## Resuming interrupted runs

Every run checkpoints to the database as nodes and generations complete. If the process dies (Ctrl+C, crash, network), nothing is lost:

    npm run cli -- --resume <runId> --db ./run.db

The config comes from the database; finished nodes keep their scores; the budget continues from cumulative spend. Add `--config original.json` alongside to re-supply what the database doesn't store: config-file API keys, `systemPrompts` overrides, and `plugins` (plugin operators that aren't re-registered fall back to carrying the parent forward). Runs with a `seed` resume bit-deterministically. Finished runs refuse to resume — reseed a new run from `best.prompt` instead.
```
  `.claude/skills/evolving-prompts/SKILL.md`, after the seed bullet: `- Interrupted run (crash/Ctrl+C)? \`--resume <runId>\` continues from the checkpoint with spend intact — pass the original \`--config\` too if the run used config-file keys or plugins.`

- [ ] **Step 4: Run** — full suite; `npm run type-check` bare.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/engine.ts packages/cli/src/index.ts docs/cli.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI --resume: continue interrupted runs from checkpoint"
```

---

### Task 4: Desktop interrupted badge + Resume

**Files:**
- Modify: `apps/desktop/electron/ipc/handlers.ts` (`listEvaluations` gains `interrupted`)
- Modify: `apps/desktop/src/components/LeftSidebar.tsx` (badge + Resume action)
- Test: `apps/desktop/tests/ipc/handlers.test.ts` (extend eval:list assertions)

- [ ] **Step 1: Failing test** — in the existing `eval:list` test in `apps/desktop/tests/ipc/handlers.test.ts`, after creating a run that never ran, assert:
```ts
    const list = await invoke('eval:list');
    expect(list[0].interrupted).toBe(true); // status undefined/running + not active => resumable
```
(and for any run the tests drive to finished, `interrupted` must be `false` — add to whichever existing assertion block has a finished run, or set a run's status to 'finished' via direct DB update in the test).

- [ ] **Step 2: Implement** — `handlers.ts`: import `isEvaluationActive` from `@promptengine/core` (static import at top with the other core imports); in `listEvaluations` map:
```ts
    (run as any).interrupted = run.status !== 'finished' && !isEvaluationActive(run.id);
```
- [ ] **Step 3: LeftSidebar** — in the evaluation row rendering (locate the status display in the row item):
  - amber badge when `(evaluation as any).interrupted`: `<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">interrupted</span>` next to the existing status text;
  - Resume action (place next to the row's existing action buttons/menu, following their exact markup pattern):
```tsx
  const resumeMutation = useMutation({
    mutationFn: async (runId: string) => { await window.electronAPI.eval.start(runId); },
    onSuccess: (_, runId) => {
      useEvaluationStore.getState().subscribe(runId as UUID);
      onSelectEvaluation(runId as UUID);
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error: any) => alert(`Resume failed: ${error.message}`),
  });
```
  Button: `<Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); resumeMutation.mutate(evaluation.id); }}>Resume</Button>` shown only when `interrupted`. Check preload exposes `eval.start(runId)` (it does — the new-evaluation flow uses it; verify the exact preload method name before wiring).

- [ ] **Step 4: Run** — desktop tests green; `npm run type-check` bare; rebuild `npm run build:dev -w apps/desktop`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/ipc/handlers.ts apps/desktop/src/components/LeftSidebar.tsx apps/desktop/tests/ipc/handlers.test.ts
git commit -m "Desktop: interrupted badge + resume for checkpointed runs"
```

---

### Task 5: Live kill-resume verification

**Files:** none committed (scratchpad only).

- [ ] **Step 1**: Scratch config: flash-lite, 3 llm_grade-light tests (2 exact_match + 1 llm_grade keeps it cheap), populationSize 3, maxGenerations 3, `"seed": 42`, budget 0.03. Start via `npm run cli` as a background process writing stderr to a log; wait until the log shows generation 1 activity (poll for `generation_created` / `Moving to generation`), then kill the process tree (`taskkill /PID <pid> /T /F` via PowerShell — the bash `$!` PID is the npm wrapper, kill the tree).
- [ ] **Step 2**: Inspect the DB (`node` + sql.js or run `--resume` directly): `--resume <runId> --db <same db> --output resumed.json`. Assert from output + logs: "Resuming run … already spent" line; exit 0; results.json spans all 3 generations; `totals.usd` > the spend visible in the interrupted log; report exists.
- [ ] **Step 3**: Determinism spot-check: the resumed run's gen-0/gen-1 node prompts and temperatures equal what the interrupted log/checkpoint showed (they were checkpointed, so identical by construction) — and the run completes to `stopReason: 'target'`.
- [ ] **Step 4**: Desktop CDP smoke: rebuild, boot with `--remote-debugging-port=9222`. Verify via CDP that `window.electronAPI.eval.list()` rows carry the `interrupted` boolean, and — if any row has `interrupted: true` in the shared dev DB — that its Resume button renders. If the dev DB happens to contain no interrupted run, the flag check alone passes the smoke (the button rendering is covered by the flag + the Step 1 unit test).
- [ ] **Step 5**: Report numbers; mismatch → STOP and diagnose.
