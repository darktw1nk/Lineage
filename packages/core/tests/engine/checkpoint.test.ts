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
        (stmt as any).run = (...args: any[]) => { snapshots.push(JSON.parse(args[0])); return origRun(...args); };
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
