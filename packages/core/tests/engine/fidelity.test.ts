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
import type { ProviderAdapter } from '../../src/types.js';

interface CallRecord { system?: string; prompt: string; seed?: number; }
let calls: CallRecord[] = [];

function fakeAdapter(output: (c: CallRecord) => string): ProviderAdapter {
  return {
    name: 'fake',
    estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const rec = { system: opts.system, prompt: opts.prompt, seed: opts.seed };
      calls.push(rec);
      return { output: output(rec), promptTokens: 2, completionTokens: 3, latencyMs: 5, usd: 0.001 };
    },
  };
}

function makeConfig(overrides: any = {}) {
  return {
    id: 'f-cfg', name: 'fidelity',
    selection: { policy: 'topk', topK: 1 },
    operators: { mutationShare: 0, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED SYSTEM PROMPT', fill: 'auto' },
    enabledModels: [{ provider: 'fake', model: 'fake-1' }],
    testSet: [{ id: 't1', name: 'one', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'fake', model: 'fake-1' },
    parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
    ...overrides,
  } as any;
}

async function runOnce(config: any): Promise<any[]> {
  const tmpDb = path.join(os.tmpdir(), `pe-fid-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run = {
    id: 'r-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [], cacheHits: 0, version: '1.0',
  } as any;
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, data) => {
    events.push(data);
    if (data.type === 'status' && data.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return events;
}

beforeEach(() => { resetRegistry(); calls = []; });

describe('promptMode', () => {
  it("default 'system': candidate prompt in system, test input as user prompt", async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    await runOnce(makeConfig());
    const evalCalls = calls.filter(c => c.prompt === 'INPUT ONE');
    expect(evalCalls.length).toBeGreaterThan(0);
    expect(evalCalls[0].system).toBe('SEED SYSTEM PROMPT');
  });

  it("'inline': concatenated single prompt, no system", async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    await runOnce(makeConfig({ promptMode: 'inline' }));
    const evalCalls = calls.filter(c => c.prompt.includes('INPUT ONE'));
    expect(evalCalls[0].prompt).toBe('SEED SYSTEM PROMPT\n\nINPUT ONE');
    expect(evalCalls[0].system).toBeUndefined();
  });
});

describe('samplesPerTest', () => {
  it('runs N samples, averages scores, records the samples array', async () => {
    // Alternate outputs: exact match on even calls only → scores 10,0,10 → mean 6.67
    let n = 0;
    registerProvider({ adapter: fakeAdapter(() => (n++ % 2 === 0 ? 'INPUT ONE' : 'WRONG')) });
    const events = await runOnce(makeConfig({
      samplesPerTest: 3,
      testSet: [{ id: 't1', name: 'one', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE',
                  grading: { strictZeroOnDeviation: true } }],
    }));
    const node = events.filter(e => e.type === 'node_updated').map(e => e.node).find(nd => nd.tests?.length);
    const tr = node.tests[0];
    expect(tr.samples).toHaveLength(3);
    expect(tr.score).toBeCloseTo((10 + 0 + 10) / 3, 5);
    expect(tr.passed).toBe(true); // strict majority: 2/3 exact
    expect(tr.promptTokens).toBe(6); // summed 2*3
  });
});

describe('holdout generalization', () => {
  it('evaluates seed and champion on held-out tests and emits holdout_result', async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) }); // echo → exact_match passes when expected === input
    const events = await runOnce(makeConfig({
      targets: { maxGenerations: 1 },
      testSet: [
        { id: 'fit1', name: 'fitness test', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE' },
        { id: 'hold1', name: 'holdout test', mode: 'exact_match', prompt: 'UNSEEN INPUT', expected: 'UNSEEN INPUT', holdout: true },
      ],
    }));

    const holdoutEvent = events.find(e => e.type === 'holdout_result');
    expect(holdoutEvent).toBeDefined();
    expect(holdoutEvent.holdout.testIds).toEqual(['hold1']);
    expect(holdoutEvent.holdout.champion.score).toBeCloseTo(10, 5);
    expect(holdoutEvent.holdout.seed.score).toBeCloseTo(10, 5);
    expect(holdoutEvent.holdout.champion.perTest).toEqual([{ testId: 'hold1', score: 10 }]);

    // Holdout test ran exactly twice: once for champion, once for seed (samplesPerTest=1)
    expect(calls.filter(c => c.prompt === 'UNSEEN INPUT' || c.prompt.includes('UNSEEN INPUT')).length).toBe(2);

    // Ordering: holdout_result arrives before final finished status
    const hIdx = events.findIndex(e => e.type === 'holdout_result');
    const fIdx = events.findIndex(e => e.type === 'status' && e.status === 'finished');
    expect(hIdx).toBeLessThan(fIdx);
  });

  it('skips holdout with no-champion marker when nothing finished', async () => {
    registerProvider({ adapter: { name: 'fake', estimateTokens: () => ({ prompt: 1 }),
      call: async () => { throw new Error('always down'); } } as any });
    const events = await runOnce(makeConfig({
      testSet: [
        { id: 'fit1', name: 'f', mode: 'exact_match', prompt: 'X', expected: 'X' },
        { id: 'hold1', name: 'h', mode: 'exact_match', prompt: 'Y', expected: 'Y', holdout: true },
      ],
    }));
    const holdoutEvent = events.find(e => e.type === 'holdout_result');
    expect(holdoutEvent.holdout.skipped).toBe('no-champion');
  });
});

describe('evaluatePromptOnTests', () => {
  it('is callable with an arbitrary prompt and uses seed+i per sample', async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    const tmpDb = path.join(os.tmpdir(), `pe-fid2-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const { evaluatePromptOnTests } = await import('../../src/engine/evaluator_v2.js');
    const config = makeConfig({ samplesPerTest: 2 });
    const state: any = {
      config,
      run: { totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, cacheHits: 0 },
      samplesPerTest: 2, promptMode: 'system',
      gradingTotal: 0, gradingFailures: 0,
    };
    const results = await evaluatePromptOnTests(
      'ANY PROMPT', { model: { provider: 'fake', model: 'fake-1' }, temperature: 0.5, seed: 100 },
      config.testSet, state, 'run-x',
    );
    expect(results[0].samples).toHaveLength(2);
    expect(calls.map(c => c.seed)).toEqual([100, 101]);
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  });
});
