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
import { initGlobalSemaphore, withGlobalSemaphore } from '../../src/engine/semaphore.js';

function registerEcho() {
  registerProvider({
    adapter: {
      name: 'echo',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
        const p: string = opts.prompt;
        if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"x"}]' };
        if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'V' + Math.random().toString(36).slice(2, 6) };
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(over: any = {}) {
  return {
    id: 'lg-cfg', name: 'lifecycle',
    selection: { policy: 'topk', topK: 2, eliteShare: 0.05 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 2, generationSize: 2, seedPrompt: 'LG SEED', fill: 'auto' },
    enabledModels: [{ provider: 'echo', model: 'm' }],
    testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'echo', model: 'm' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

async function runWithTimeout(config: any, ms = 15000): Promise<any> {
  const tmpDb = path.join(os.tmpdir(), `pe-lg-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run: any = { id: 'lg-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

  let finished = false;
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') { finished = true; res(); }
  }));
  await startEvaluation(run.id, config, run);
  await Promise.race([done, new Promise(r => setTimeout(r, ms))]);

  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return { finished, final };
}

beforeEach(() => resetRegistry());

describe('lifecycle guards', () => {
  it('parallelLimit 0 is resolved instead of hanging forever', async () => {
    // Bug hunt: the loop compares activePromises.size < config.parallelLimit,
    // so 0 (or undefined) started no nodes and spun on a 100ms sleep forever.
    registerEcho();
    const { finished, final } = await runWithTimeout(makeConfig({ parallelLimit: 0 }), 15000);
    expect(finished).toBe(true);
    expect(final.status).toBe('finished');
  }, 30000);

  it('eliteShare 1.0 still evolves instead of silently ending the run', async () => {
    // With numElite === population every child was a finished clone: nothing was
    // ever queued, so the run ended with no stopReason and no evolution.
    registerEcho();
    const { finished, final } = await runWithTimeout(
      makeConfig({ selection: { policy: 'topk', topK: 2, eliteShare: 1.0 }, targets: { maxGenerations: 3 } }),
      15000,
    );
    expect(finished).toBe(true);
    expect(final.generations.length).toBe(3);  // reached maxGenerations
    expect(final.stopReason).toBe('target');   // and said why it stopped
    // The final generation contains at least one genuinely new (non-elite) child
    const lastGen = final.generations[final.generations.length - 1];
    expect(lastGen.some((n: any) => n.changeLog?.[0]?.label !== 'ELITE')).toBe(true);
  }, 30000);
});

describe('global semaphore', () => {
  it('re-initialising while calls are in flight does not inflate the limit', async () => {
    initGlobalSemaphore(2);
    let active = 0, peak = 0;
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>(res => { releaseAll = res; });

    const task = () => withGlobalSemaphore(async () => {
      active++; peak = Math.max(peak, active);
      await gate;
      active--;
      return null;
    }, 'test');

    const running = Array.from({ length: 6 }, task);
    await new Promise(r => setTimeout(r, 20));
    expect(peak).toBe(2); // baseline honoured

    // Re-init mid-flight (a second run starting, or a settings change)
    initGlobalSemaphore(2);
    await new Promise(r => setTimeout(r, 20));
    expect(peak).toBe(2); // must NOT have re-issued the held permits

    releaseAll();
    await Promise.all(running);
    expect(peak).toBe(2);
  }, 20000);
});
