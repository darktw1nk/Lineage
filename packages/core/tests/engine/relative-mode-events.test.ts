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

function registerDet() {
  registerProvider({ adapter: { name: 'rel', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
      const p: string = opts.prompt;
      if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
      if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'P' + Math.random() };
      return { ...base, output: opts.system ?? p };
    } } as any });
}

const baseConfig = (over: any = {}) => ({
  id: 'rel-cfg', name: 'relative',
  selection: { policy: 'topk', topK: 3 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 8, generationSize: 8, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'rel', model: 'm' }],
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 4 },
  serviceModel: { provider: 'rel', model: 'm' },
  parallelLimit: 4, serviceModelMaxTokens: 100, retries: 1, seed: 7,
  ...over,
} as any);

async function countNodeUpdates(config: any): Promise<{ updates: number; nodes: number }> {
  const tmpDb = path.join(os.tmpdir(), `pe-rel-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run: any = { id: 'rel-run-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

  let updates = 0;
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'node_updated') updates++;
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return { updates, nodes: final.generations.flat().length };
}

beforeEach(() => { resetRegistry(); });

describe('relative-mode fitness does not emit a quadratic event storm', () => {
  it('emits about as many node_updated events as absolute mode', async () => {
    // recalculateAllFitness ran on EVERY node completion and emitted one
    // node_updated per already-finished node — n^2/2 events. Measured on
    // 6 generations x 30 nodes: 369 events absolute, 15,574 relative (42x).
    // At 600 nodes that is ~180,000 events, each carrying a full node over
    // IPC and rebuilding the entire React Flow graph.
    registerDet();
    const absolute = await countNodeUpdates(baseConfig());

    resetRegistry(); registerDet();
    const relative = await countNodeUpdates(baseConfig({
      id: 'rel-cfg-2',
      fitness: {
        weights: { quality: 0.8, latency: 0.2 },
        latencyNorm: { mode: 'relative', maxMs: 1000 },
      },
    }));

    expect(relative.nodes).toBe(absolute.nodes);
    // Was 42x. Allow generous headroom for genuine recalculations — the point
    // is that it is a small multiple, not a multiple of the node count.
    expect(relative.updates).toBeLessThan(absolute.updates * 3);
    expect(relative.updates).toBeLessThan(relative.nodes * 3);
  }, 120000);
});
