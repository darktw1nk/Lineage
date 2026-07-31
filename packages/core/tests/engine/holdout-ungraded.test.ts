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

/**
 * Gap mutation testing found in evaluator_v2.ts (hunt 13).
 *
 * calculateQualityScore scores an ungraded test 0 and has three tests saying so.
 * runHoldoutEvaluation has its OWN mean — `scoreOf` — and nothing pins it, so
 * deleting its ungraded filter survives a fully green suite. That mean is the
 * number docs/cli.md calls "the honest one": if a fabricated 5.0 placeholder
 * counts there, the generalisation figure the report leads with is invented.
 */

function judgeAwareAdapter(): ProviderAdapter {
  return {
    name: 'fake',
    estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const prompt = String(opts.prompt ?? '');
      const isJudge = prompt.includes('Rubric (1..10)');
      // The judge answers cleanly on the fitness test and in unparseable prose
      // on the holdout test — the ordinary "judge replied in prose" failure.
      const output = !isJudge
        ? 'ANSWER'
        : prompt.includes('HOLD INPUT')
          ? 'Honestly it was pretty good overall.'
          : '{"score": 9, "justification": "fine"}';
      return { output, promptTokens: 2, completionTokens: 3, latencyMs: 5, usd: 0 };
    },
  };
}

function makeConfig() {
  return {
    id: 'h-cfg', name: 'holdout-ungraded',
    selection: { policy: 'topk', topK: 1 },
    operators: { mutationShare: 0, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'fake', model: 'fake-1' }],
    testSet: [
      { id: 't1', name: 'fit', mode: 'llm_grade', prompt: 'FIT INPUT' },
      { id: 't2', name: 'hold', mode: 'llm_grade', prompt: 'HOLD INPUT', holdout: true },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'fake', model: 'fake-1' },
    parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
  } as any;
}

async function runOnce(config: any): Promise<any[]> {
  const tmpDb = path.join(os.tmpdir(), `pe-hold-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
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

beforeEach(() => { resetRegistry(); });

describe('the holdout mean refuses a fabricated placeholder', () => {
  it('an ungraded holdout test scores 0, not the 5.0 placeholder', async () => {
    registerProvider({ adapter: judgeAwareAdapter() });
    const events = await runOnce(makeConfig());

    const holdout = events.filter(e => e.type === 'holdout_result').pop()?.holdout;
    expect(holdout).toBeDefined();
    expect(holdout.skipped).toBeUndefined();

    // The judge answered in prose on the holdout test, so nothing was measured.
    // 5.0 is a NUMBER THAT LOOKS LIKE A GRADE — averaging it in is how a run
    // whose judge said nothing reported "seed 5.0 -> champion 5.0".
    expect(holdout.champion.score).toBe(0);
    expect(holdout.seed.score).toBe(0);
    expect(holdout.champion.perTest[0].ungraded).toBe(true);
  }, 30000);
});
