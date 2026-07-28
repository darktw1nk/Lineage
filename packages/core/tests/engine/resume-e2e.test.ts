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

let evalPrompts: string[] = []; // candidate prompts the adapter actually evaluated

function registerDet() {
  registerProvider({ adapter: { name: 'det', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
      const p: string = opts.prompt;
      if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
      if (p.includes('Produce the NEW prompt ONLY')) {
        let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
        return { ...base, output: `PROMPT-${(h >>> 0).toString(36)}` };
      }
      evalPrompts.push(opts.system ?? '');
      return { ...base, output: opts.system ?? p };
    } } as any });
}

const CONFIG = {
  id: 'rs-cfg', name: 'resume e2e',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 3, generationSize: 3, seedPrompt: 'RS SEED', fill: 'auto' },
  enabledModels: [{ provider: 'det', model: 'm' }],
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 3 },
  serviceModel: { provider: 'det', model: 'm' },
  parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  seed: 42,
} as any;

function decisionSignature(run: any) {
  return run.generations.map((g: any[]) => g.map(n => ({
    prompt: n.prompt, label: n.changeLog?.[0]?.label, temp: n.params?.temperature, nodeSeed: n.params?.seed,
  })));
}

async function runToCompletion(run: any): Promise<any> {
  const tmpDb = path.join(os.tmpdir(), `pe-rs-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(run.id, CONFIG, run);
  await done;
  const finalRun = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return finalRun;
}

const freshRun = () => ({ id: 'rs-run-' + Math.random().toString(36).slice(2), configId: CONFIG.id, startedAt: Date.now(),
  totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' });

beforeEach(() => { resetRegistry(); evalPrompts = []; });

describe('resume from checkpoint', () => {
  it('a truncated run resumes to the same decision signature as an uninterrupted one, without re-evaluating finished nodes', async () => {
    registerDet();
    const full = await runToCompletion(freshRun());
    const fullSig = decisionSignature(full);
    expect(full.generations.length).toBe(3);

    // Build the "crashed at gen 1" state from the completed run: drop gen 2,
    // and reset two of gen 1's nodes to a mid-flight state (keep one finished).
    const truncated = JSON.parse(JSON.stringify(full));
    truncated.id = 'rs-resumed';
    truncated.status = 'running';
    delete truncated.finishedAt; delete truncated.stopReason;
    truncated.generations = truncated.generations.slice(0, 2);
    const gen1 = truncated.generations[1];
    const keptFinishedPrompt = gen1[0].prompt;
    for (const n of gen1.slice(1)) { n.status = 'running'; delete n.tests; delete n.metrics; }
    const baseUsd = truncated.totals.usd;

    resetRegistry(); registerDet(); evalPrompts = [];
    const resumed = await runToCompletion(truncated);

    expect(resumed.status).toBe('finished');
    expect(resumed.generations.length).toBe(3);
    expect(decisionSignature(resumed)).toEqual(fullSig); // seeded resume == uninterrupted run
    expect(resumed.totals.usd).toBeGreaterThan(baseUsd); // spend accumulated, not reset

    // Finished nodes were NOT re-evaluated: gen 0 prompts and the kept gen-1 node
    // never hit the adapter again (cache may also shield them — either way, no calls)
    expect(evalPrompts).not.toContain(keptFinishedPrompt);
    for (const n of full.generations[0]) expect(evalPrompts).not.toContain(n.prompt);
  }, 60000);

  it('refuses to resume a finished run', async () => {
    registerDet();
    const full = await runToCompletion(freshRun());
    const again = JSON.parse(JSON.stringify(full));
    again.id = 'rs-finished';
    const tmpDb = path.join(os.tmpdir(), `pe-rs-fin-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(again.id, again.configId, again.startedAt, JSON.stringify(again), again.version);
    await expect(startEvaluation(again.id, CONFIG, again)).rejects.toThrow(/already finished/);
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  }, 60000);

  it('resumes a run interrupted during the initial fill (pending gen-0 mutations)', async () => {
    registerDet();
    // Gen 0 as checkpointed mid-fill: baseline awaiting, two nodes still waiting for mutation
    const run: any = freshRun();
    run.status = 'running';
    run.generations = [[
      { id: 'n0', generation: 0, lineageParents: [], status: 'awaiting', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 1 },
        changeLog: [{ label: 'MUTATION', text: 'Seed prompt (baseline)' }] },
      { id: 'n1', generation: 0, lineageParents: [], status: 'pending', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 2 },
        changeLog: [{ label: 'MUTATION', text: 'Waiting for mutation...' }] },
      { id: 'n2', generation: 0, lineageParents: [], status: 'running', prompt: 'RS SEED',
        params: { model: { provider: 'det', model: 'm' }, temperature: 0, seed: 3 },
        changeLog: [{ label: 'MUTATION', text: 'Waiting for mutation...' }] },
    ]];
    const resumed = await runToCompletion(run);
    expect(resumed.status).toBe('finished');
    // Both waiting nodes got real mutations (changelog no longer the placeholder)
    const gen0 = resumed.generations[0];
    expect(gen0.filter((n: any) => n.changeLog?.[0]?.text === 'Waiting for mutation...').length).toBe(0);
    expect(gen0.every((n: any) => n.status === 'finished')).toBe(true);
    expect(resumed.generations.length).toBe(3);
  }, 60000);
});
