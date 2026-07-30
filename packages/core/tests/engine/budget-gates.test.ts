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
import { setSendUpdate, startEvaluation, stopEvaluation } from '../../src/engine/evaluator_v2.js';

/**
 * budget-enforcement.test.ts only ever exercises `shouldStop`, which is
 * consulted at NODE boundaries. Mutation testing (pass 8) removed every
 * per-call gate — the pre-call `budgetExhausted`, `reserveCall`, the playoff
 * gate and the holdout gate — and all 595 tests stayed green. These pin the
 * gates that sit at the actual spend points.
 */
const USD = 0.01;
let candidateCalls = 0;
let gradingCalls = 0;
let judgeCalls = 0;
let operatorCalls = 0;

function registerPricedAdapter(onCall?: (kind: string) => void) {
  registerProvider({
    adapter: {
      name: 'priced',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD };
        const p: string = opts.prompt;
        if (p.includes('"winner"')) {
          judgeCalls++; onCall?.('judge');
          return { ...base, output: JSON.stringify({ winner: 'A', reason: 's' }) };
        }
        if (p.includes('Rubric')) {
          gradingCalls++; onCall?.('grading');
          return { ...base, output: JSON.stringify({ score: 8, justification: 's' }) };
        }
        if (p.includes('mutations to improve') || p.includes('Produce the NEW prompt ONLY')) {
          operatorCalls++; onCall?.('operator');
          return {
            ...base,
            output: p.includes('mutations to improve')
              ? '[{"label":"MUTATION","edit":"t"}]'
              : `VARIANT ${operatorCalls}`,
          };
        }
        candidateCalls++; onCall?.('candidate');
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(over: any = {}) {
  return {
    id: 'bgate-cfg', name: 'budget gates',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'priced', model: 'm1' }],
    testSet: [{ id: 't1', name: 'a', mode: 'llm_grade', prompt: 'A' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'priced', model: 'm1' },
    parallelLimit: 1, samplesPerTest: 1,
    serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

async function run(
  config: any,
  hooks: { onStart?: (runId: string) => void; settleMs?: number } = {},
): Promise<{ final: any; events: any[] }> {
  const tmpDb = path.join(os.tmpdir(), `pe-bgate-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const runRow: any = {
    id: 'bgate-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0',
  };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(runRow.id, runRow.configId, runRow.startedAt, JSON.stringify(runRow), runRow.version);

  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    events.push(d);
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(runRow.id, config, runRow);
  hooks.onStart?.(runRow.id);
  await done;
  // Work that leaked past the finish (an operator batch that was never told to
  // stop) is still running. Give it time to show up in the call counters.
  if (hooks.settleMs) await new Promise(r => setTimeout(r, hooks.settleMs));
  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(runRow.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return { final, events };
}

beforeEach(() => {
  resetRegistry();
  candidateCalls = gradingCalls = judgeCalls = operatorCalls = 0;
});

describe('the cap is checked at the spend point, not only at node boundaries', () => {
  it('refuses the grading calls of a node whose own candidate calls blew the cap', async () => {
    // ONE node, ONE generation, no operator work: the only spend is this node's
    // own 8 tests. `shouldStop` cannot help — it is not consulted again until
    // the node finishes — so with no per-call gate all 8 candidate calls AND
    // all 8 grading calls execute in full against a 2-call budget.
    registerPricedAdapter();
    const { final } = await run(makeConfig({
      operators: { mutationShare: 0, crossoverShare: 0 },
      testSet: Array.from({ length: 8 }, (_v, i) => ({ id: `t${i}`, name: `t${i}`, mode: 'llm_grade', prompt: `P${i}` })),
      targets: { maxGenerations: 1, budgetUSD: 2 * USD },
    }));

    expect(candidateCalls).toBe(8);         // all dispatched in one tick, all read $0
    expect(gradingCalls).toBeLessThanOrEqual(2); // …but the second phase must be refused
    expect(final.stopReason).toBe('budget');
  }, 60000);

  it('a node abandoned by the cap is "skipped", not "failed"', async () => {
    // 'failed' makes the report open with "❌ Every candidate failed — this run
    // produced nothing usable" for a run whose only problem was the budget.
    registerPricedAdapter();
    const { final } = await run(makeConfig({
      operators: { mutationShare: 0, crossoverShare: 0 },
      testSet: Array.from({ length: 8 }, (_v, i) => ({ id: `t${i}`, name: `t${i}`, mode: 'llm_grade', prompt: `P${i}` })),
      targets: { maxGenerations: 1, budgetUSD: 2 * USD },
    }));
    const statuses = final.generations.flat().map((n: any) => n.status);
    expect(statuses).toContain('skipped');
    expect(statuses).not.toContain('failed');
  }, 60000);
});

describe('the end-of-run phases are gated too', () => {
  it('marks the holdout skipped:"budget" instead of emitting an empty one', async () => {
    // The holdout's own calls are gated, so removing this pre-check does not
    // overspend — it produces a holdout object with NO scores and NO `skipped`
    // marker, and the report then prints a heading with nothing under it.
    registerPricedAdapter();
    const { final } = await run(makeConfig({
      operators: { mutationShare: 0, crossoverShare: 0 },
      testSet: [
        { id: 't1', name: 'train', mode: 'llm_grade', prompt: 'A' },
        { id: 'h1', name: 'held out', mode: 'exact_match', prompt: 'H', expected: 'SEED', holdout: true },
      ],
      targets: { maxGenerations: 1, budgetUSD: 2 * USD }, // exactly the evolution's cost
    }));

    expect(final.holdout).toBeDefined();
    expect(final.holdout.skipped).toBe('budget');
    expect(final.holdout.champion).toBeUndefined();
    expect(final.holdout.seed).toBeUndefined();
  }, 60000);

  it('does not record a playoff it never funded', async () => {
    // Without the pre-check the playoff is entered, aborts on its first
    // shouldAbort poll with zero matches, and still records a ranking whose
    // points are all zero — a coin-flip ordering written to the run.
    registerPricedAdapter();
    // 2 fill calls + 2 nodes x (candidate + grading) = 6 calls exactly. The cap
    // is set to that, so both nodes FINISH (2 valid contenders) and the budget
    // is gone by the time the playoff would run.
    const { final, events } = await run(makeConfig({
      population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
      testSet: [{ id: 't1', name: 'a', mode: 'llm_grade', prompt: 'A' }],
      pairwise: { enabled: true, contenders: 2 },
      targets: { maxGenerations: 1, budgetUSD: 6 * USD },
    }));

    expect(final.stopReason).toBe('budget');
    expect(final.generations.flat().filter((n: any) => n.status === 'finished')).toHaveLength(2);
    expect(judgeCalls).toBe(0);
    expect(final.playoffs).toBeUndefined();
    expect(events.some(e => e.type === 'playoff_result')).toBe(false);
  }, 60000);
});

describe('a manual Stop reaches the phases that keep spending', () => {
  it('aborts the operator batch of a generation transition', async () => {
    // `exhausted()` is the operator batch's only stop signal. With
    // `state.stopRequested` removed from it, a Stop pressed while a transition
    // is running still funds every remaining child (2 service calls each).
    let stopper: (() => void) | null = null;
    // initialSize 2 => the population fill makes the first 2 operator calls.
    // Stop on the 3rd, which is the first call of the generation transition.
    registerPricedAdapter(kind => { if (kind === 'operator' && operatorCalls === 3) stopper?.(); });
    const { final } = await run(
      makeConfig({
        population: { initialSize: 2, generationSize: 12, seedPrompt: 'SEED', fill: 'auto' },
        testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'A' }],
        targets: { maxGenerations: 3 }, // no cap: isolate the Stop
        parallelLimit: 1,
      }),
      { onStart: runId => { stopper = () => stopEvaluation(runId); }, settleMs: 400 },
    );

    expect(final.stopReason).toBe('manual');
    // 12 children x 2 service calls = 24 operator calls if nothing aborts.
    // The population fill spends the first 2; the 3rd is the transition's
    // first child, and that is where the Stop lands. Everything after it must
    // carry the parent forward unpaid.
    expect(operatorCalls).toBeLessThanOrEqual(6);
  }, 60000);
});
