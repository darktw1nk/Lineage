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

let promptCounter = 0;

// One fake provider serving ALL roles, discriminated by prompt content
function registerOmniAdapter() {
  registerProvider({
    adapter: {
      name: 'omni',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 4, completionTokens: 2, latencyMs: 1, usd: 0.0001 };
        const p: string = opts.prompt;
        if (p.includes('"winner"')) {
          return { ...base, output: JSON.stringify({ winner: 'A', reason: 's' }) };
        }
        if (p.includes('Rubric')) {
          return { ...base, output: JSON.stringify({ score: 9, justification: 's' }) };
        }
        if (p.includes('mutations to improve')) {
          return { ...base, output: '[{"label":"MUTATION","edit":"tweak"}]' };
        }
        if (p.includes('Produce the NEW prompt ONLY')) {
          return { ...base, output: `VARIANT PROMPT ${++promptCounter}` };
        }
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

const config = {
  id: 'cb-cfg', name: 'cost breakdown e2e',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'CB SEED PROMPT', fill: 'auto' },
  enabledModels: [{ provider: 'omni', model: 'm1' }],
  testSet: [
    { id: 't1', name: 'graded', mode: 'llm_grade', prompt: 'THE INPUT', expected: 'REF' },
    { id: 'h1', name: 'held out', mode: 'exact_match', prompt: 'HOLD INPUT', expected: 'CB SEED PROMPT', holdout: true },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 2 },
  serviceModel: { provider: 'omni', model: 'm1' },
  parallelLimit: 2, serviceModelMaxTokens: 200, retries: 1,
  pairwise: { enabled: true, contenders: 2 },
  seed: 42,
} as any;

beforeEach(() => { resetRegistry(); promptCounter = 0; });

describe('categorized cost accounting', () => {
  it('accumulates per-purpose and per-model records whose sums equal totals exactly', async () => {
    registerOmniAdapter();
    const tmpDb = path.join(os.tmpdir(), `pe-cb-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = { id: 'cb-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    const events: any[] = [];
    const done = new Promise<void>(res => setSendUpdate((_id, d) => {
      events.push(JSON.parse(JSON.stringify(d)));
      if (d.type === 'status' && d.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    await done;

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
    expect(sum(purposes, 'usd')).toBeCloseTo(finalRun.totals.usd, 10);
    expect(sum(purposes, 'calls')).toBe(finalRun.totals.calls);
    expect(sum(purposes, 'promptTokens')).toBe(finalRun.totals.tokensPrompt);
    expect(sum(purposes, 'completionTokens')).toBe(finalRun.totals.tokensCompletion);
    for (const f of ['usd', 'calls', 'promptTokens', 'completionTokens']) {
      expect(sum(models, f)).toBeCloseTo(sum(purposes, f), 10);
    }

    // Holdout calls tagged separately (holdout test is exact_match => no Holdout grading)
    expect(bd['Holdout evaluation'].calls).toBe(2); // champion + seed x 1 test x 1 sample

    // Event emitted before finished, carrying the breakdown
    const bdEventIdx = events.findIndex(e => e.type === 'cost_breakdown');
    const finIdx = events.findIndex(e => e.type === 'status' && e.status === 'finished');
    expect(bdEventIdx).toBeGreaterThan(-1);
    expect(bdEventIdx).toBeLessThan(finIdx);
    expect(events[bdEventIdx].breakdown['Candidate evaluations'].calls).toBeGreaterThan(0);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 30000);
});
