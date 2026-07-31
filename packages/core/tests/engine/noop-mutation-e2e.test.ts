import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';

/**
 * Open-bugs 2026-07-31 #1, end to end. In the observed run (results2.json,
 * generation 0) a mutation returned the seed byte-for-byte; the engine adopted
 * it under a changelog listing two applied mutations and paid THREE candidate
 * evaluations to re-measure a prompt it had already measured — because seeded
 * runs derive a DIFFERENT provider seed per gen-0 sibling, so the identical
 * prompt never hit the evaluation cache.
 *
 * With the fix, a no-op fill (a) carries an honest CARRY changelog and (b) is
 * aligned with node 0's params so the cache serves its evaluation for free.
 */
let candidateCalls = 0;
let judgeCalls = 0;

function registerNoopMutationAdapter() {
  registerProvider({ adapter: {
    name: 'noopy',
    estimateTokens: () => ({ prompt: 10 }),
    call: async (opts: any) => {
      const base = { promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: 0.001 };
      if (/propose mutations/i.test(opts.prompt)) {
        return { ...base, output: '[{"label":"MUTATION","edit":"[Removal] Remove overly cautious constraints that prevent the model from making necessary changes"}]' };
      }
      if (/apply edit instructions/i.test(opts.prompt)) {
        // The no-op: the "rewritten" prompt is the seed, verbatim.
        return { ...base, output: 'SEED PROMPT' };
      }
      if (/Rubric|score/i.test(opts.prompt)) {
        judgeCalls++;
        return { ...base, output: '{"score": 8, "justification": "ok"}' };
      }
      candidateCalls++;
      return { ...base, output: 'ANSWER' };
    },
  } as any });
}

const config = {
  id: 'noop-cfg', name: 'noop mutation e2e',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED PROMPT', fill: 'auto' },
  enabledModels: [{ provider: 'noopy', model: 'm1' }],
  testSet: [{ id: 't1', name: 'train', mode: 'llm_grade', prompt: 'A' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'noopy', model: 'm1' },
  parallelLimit: 2, samplesPerTest: 1,
  serviceModelMaxTokens: 100, retries: 1,
  seed: 7, // seeded: gen-0 siblings get DIFFERENT derived provider seeds
} as any;

beforeEach(() => {
  resetRegistry();
  candidateCalls = judgeCalls = 0;
});

describe('a no-op gen-0 fill is honest and free to evaluate', () => {
  it('carries an honest changelog and is served from the cache, not re-billed', async () => {
    registerNoopMutationAdapter();
    const tmpDb = path.join(os.tmpdir(), `pe-noop-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = { id: 'noop-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    const done = new Promise<void>(res => setSendUpdate((_id, d: any) => {
      if (d.type === 'status' && d.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    await done;

    const final = JSON.parse(
      (db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json,
    );

    const gen0 = final.generations[0];
    expect(gen0).toHaveLength(2);
    const filled = gen0[1];

    // (a) The changelog must not claim mutations that never happened.
    expect(filled.prompt).toBe('SEED PROMPT');
    expect(filled.changeLog.some((l: any) => l.label === 'MUTATION' && /Removal/.test(l.text))).toBe(false);
    expect(filled.changeLog[0].label).toBe('CARRY');

    // (b) The duplicate measurement is served by the cache: one candidate call
    // for the single test, not one per identical node.
    expect(candidateCalls).toBe(1);
    expect(final.cacheHits).toBeGreaterThanOrEqual(1);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 60000);
});
