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

let candidateCalls = 0;

function registerCountingAdapter() {
  candidateCalls = 0;
  registerProvider({
    adapter: {
      name: 'counting',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.01 };
        const p: string = opts.prompt;
        if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"x"}]' };
        // Deterministic apply: every mutation yields the SAME prompt, which is
        // what a temperature-0 service model does.
        if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'IDENTICAL VARIANT' };
        await new Promise(r => setTimeout(r, 20)); // widen the race window
        candidateCalls++;
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(parallelLimit: number) {
  return {
    id: 'cd-cfg', name: 'cache-dedup',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 5, generationSize: 5, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'counting', model: 'm' }],
    testSet: [
      { id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' },
      { id: 't2', name: 'b', mode: 'exact_match', prompt: 'IN2', expected: 'IN2' },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'counting', model: 'm' },
    parallelLimit, serviceModelMaxTokens: 100, retries: 1,
  } as any;
}

async function run(config: any): Promise<{ calls: number; cacheHits: number }> {
  const tmpDb = path.join(os.tmpdir(), `pe-cd-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const runRow: any = { id: 'cd-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
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
  fs.rmSync(`${tmpDb}.lock`, { force: true });
  setSendUpdate(() => {});
  return { calls: candidateCalls, cacheHits: final.cacheHits };
}

beforeEach(() => resetRegistry());

describe('duplicate prompts in one generation are evaluated once', () => {
  it('parallelLimit does not multiply candidate spend (bug-hunt regression)', async () => {
    // The cache entry was written only AFTER the evaluation resolved, and the
    // loop dispatches the whole batch in one tick — so every duplicate prompt
    // missed the cache and paid in full. Measured +75% total spend purely from
    // raising parallelLimit, on an identical population.
    registerCountingAdapter();
    const serial = await run(makeConfig(1));
    resetRegistry();
    registerCountingAdapter();
    const parallel = await run(makeConfig(5));

    expect(parallel.calls).toBe(serial.calls);
    expect(parallel.cacheHits).toBeGreaterThan(0);
  }, 60000);
});
