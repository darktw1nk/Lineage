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

const USD_PER_CALL = 0.01;
let adapterCalls = 0;

// Every call costs a fixed, non-trivial amount so overshoot is easy to measure
function registerPricedAdapter() {
  registerProvider({
    adapter: {
      name: 'priced',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        adapterCalls++;
        const base = { promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD_PER_CALL };
        const p: string = opts.prompt;
        if (p.includes('Rubric')) return { ...base, output: JSON.stringify({ score: 8, justification: 's' }) };
        if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
        if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'VARIANT ' + adapterCalls };
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(over: any = {}) {
  return {
    id: 'bg-cfg', name: 'budget',
    selection: { policy: 'topk', topK: 3 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'priced', model: 'm1' }],
    testSet: [
      { id: 't1', name: 'a', mode: 'llm_grade', prompt: 'A' },
      { id: 't2', name: 'b', mode: 'llm_grade', prompt: 'B' },
      { id: 't3', name: 'c', mode: 'llm_grade', prompt: 'C' },
      { id: 't4', name: 'd', mode: 'llm_grade', prompt: 'D' },
      { id: 't5', name: 'e', mode: 'llm_grade', prompt: 'E' },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 5, budgetUSD: 0.02 },
    serviceModel: { provider: 'priced', model: 'm1' },
    parallelLimit: 8,
    samplesPerTest: 3,
    serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

async function run(config: any): Promise<any> {
  const tmpDb = path.join(os.tmpdir(), `pe-bg-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const runRow: any = { id: 'bg-run-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(runRow.id, runRow.configId, runRow.startedAt, JSON.stringify(runRow), runRow.version);
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(runRow.id, config, runRow);
  await done;
  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(runRow.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return final;
}

beforeEach(() => { resetRegistry(); adapterCalls = 0; });

describe('budget enforcement', () => {
  it('bounds overshoot: parallel samples cannot blow far past budgetUSD', async () => {
    // Bug-hunt finding: shouldStop was only consulted at node boundaries, so a
    // 5-test x 3-sample x parallelLimit-8 config overshot the cap by 120x.
    registerPricedAdapter();
    const final = await run(makeConfig());

    expect(final.stopReason).toBe('budget');
    // Real spend must stay within a small multiple of the cap. The remaining
    // slack is the in-flight calls already dispatched when the cap is crossed.
    const overshoot = final.totals.usd / 0.02;
    expect(overshoot).toBeLessThan(5);
    // Sanity: accounting still adds up
    expect(final.totals.calls * USD_PER_CALL).toBeCloseTo(final.totals.usd, 10);
  }, 60000);

  it('overshoot does not grow with parallelLimit', async () => {
    // The real defect behind the loose bound above: a node fires every
    // test x sample in ONE tick (Promise.all), and parallelLimit nodes do it at
    // once, so they all read the same settled totals.usd and all pass the gate.
    // The semaphore only delays them; nothing cancels a committed call.
    // Measured with a $7 cap, 5 tests x 4 samples: $26 at parallelLimit 1 and
    // $166 at parallelLimit 8 — the breach scaled with concurrency, which is
    // what makes it unbounded rather than merely sloppy.
    registerPricedAdapter();
    const serial = await run(makeConfig({ parallelLimit: 1 }));
    resetRegistry(); adapterCalls = 0; registerPricedAdapter();
    const parallel = await run(makeConfig({ parallelLimit: 8 }));

    expect(serial.stopReason).toBe('budget');
    expect(parallel.stopReason).toBe('budget');
    // Raising concurrency 8x must not raise spend. Allow one call of slack for
    // the boundary itself; the point is that it is a CONSTANT, not a multiple.
    expect(parallel.totals.usd).toBeLessThanOrEqual(serial.totals.usd + USD_PER_CALL);
    // And neither may exceed the cap by more than a single in-flight call.
    expect(parallel.totals.usd).toBeLessThanOrEqual(0.02 + USD_PER_CALL);
  }, 120000);

  it('a generation transition cannot spend a whole generation of operator calls past the cap', async () => {
    // createNextGeneration had NO budget check anywhere: once shouldStop let
    // the transition begin — i.e. with one cent left — it built a child promise
    // per child and Promise.all'd them, unbounded by parallelLimit. Measured
    // $32 against a $9 cap (356%): 4 candidate + 4 grading calls inside the cap,
    // then 24 ungated operator calls in one batch.
    registerPricedAdapter();
    const final = await run(makeConfig({
      // Cheap evaluation so the budget survives into the transition, then a
      // wide generation whose operator batch is where the money would go.
      testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'A' }],
      population: { initialSize: 2, generationSize: 12, seedPrompt: 'SEED', fill: 'auto' },
      samplesPerTest: 1,
      targets: { maxGenerations: 3, budgetUSD: 0.05 },
      parallelLimit: 8,
    }));

    // 12 children x 2 calls = 24 operator calls per transition = $0.24 alone.
    expect(final.totals.usd).toBeLessThanOrEqual(0.05 + USD_PER_CALL);
    // Children the cap refused are carried forward, not silently dropped.
    const carried = final.generations.flat().filter((n: any) =>
      n.changeLog?.some((c: any) => /Budget exhausted before this operator/.test(c.text)));
    expect(carried.length).toBeGreaterThan(0);
  }, 120000);

  it('an already-exhausted budget stops the initial fill from spending', async () => {
    registerPricedAdapter();
    // Budget 0 means "spend nothing" — it must not be read as "no limit"
    const final = await run(makeConfig({ targets: { maxGenerations: 3, budgetUSD: 0 } }));
    expect(final.totals.usd).toBe(0);
    expect(adapterCalls).toBe(0);
    expect(final.stopReason).toBe('budget');
  }, 60000);

  it('the fill-phase gate bounds spend under a large initial population', async () => {
    // The gate existed but did nothing: nodesToMutate.map(async ...) drove every
    // body to its first await in one tick, so all 19 budget checks read $0.
    // Only an already-exhausted budget could trip it — which is exactly what the
    // sibling test above covers, so the bug hid behind a passing test.
    registerPricedAdapter();
    const final = await run(makeConfig({
      population: { initialSize: 20, generationSize: 20, seedPrompt: 'SEED', fill: 'auto' },
      targets: { maxGenerations: 1, budgetUSD: 0.02 }, // 2 calls' worth
      parallelLimit: 4,
    }));

    expect(final.stopReason).toBe('budget');
    expect(final.totals.usd / 0.02).toBeLessThan(5);
  }, 60000);

  it('a manual stop does not fund a playoff or holdout afterwards', async () => {
    registerPricedAdapter();
    const config = makeConfig({
      targets: { maxGenerations: 3 }, // no budget cap: isolate the stop behaviour
      pairwise: { enabled: true, contenders: 3 },
      testSet: [
        { id: 't1', name: 'a', mode: 'llm_grade', prompt: 'A' },
        { id: 'h1', name: 'h', mode: 'exact_match', prompt: 'H', expected: 'SEED', holdout: true },
      ],
    });

    const tmpDb = path.join(os.tmpdir(), `pe-bg-stop-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const runRow: any = { id: 'bg-stop-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(runRow.id, runRow.configId, runRow.startedAt, JSON.stringify(runRow), runRow.version);

    const { stopEvaluation } = await import('../../src/engine/evaluator_v2.js');
    let playoffsAtStop = 0;
    let stopped = false;
    let playoffsAfterStop = 0;
    const done = new Promise<void>(res => setSendUpdate((_id, d) => {
      if (d.type === 'playoff_result' && stopped) playoffsAfterStop++;
      if (d.type === 'status' && d.status === 'finished') res();
    }));
    await startEvaluation(runRow.id, config, runRow);
    await new Promise(r => setTimeout(r, 150)); // let some work happen
    const callsAtStop = adapterCalls;
    stopped = true;
    stopEvaluation(runRow.id);
    await done;

    const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(runRow.id) as any).run_json);
    expect(final.stopReason).toBe('manual');
    // Playoffs already judged during normal evolution are fine; the fix is that
    // Stop must not fund a NEW playoff or a holdout pass afterwards.
    expect(playoffsAfterStop).toBe(0);
    expect(final.holdout).toBeUndefined();
    void playoffsAtStop;
    // Post-stop spending is bounded by in-flight work only, not a fresh phase
    const postStopCalls = adapterCalls - callsAtStop;
    expect(postStopCalls).toBeLessThan(config.parallelLimit * 4);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 60000);
});
