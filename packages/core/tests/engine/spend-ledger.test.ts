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
import { readSpend, recordSpend, clearSpend } from '../../src/engine/spendledger.js';

const USD_PER_CALL = 0.001;

function registerPriced() {
  registerProvider({ adapter: { name: 'led', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const base = { promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD_PER_CALL };
      const p: string = opts.prompt;
      if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
      if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'V' + Math.random() };
      return { ...base, output: opts.system ?? p };
    } } as any });
}

const CONFIG = {
  id: 'led-cfg', name: 'ledger',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 3, generationSize: 3, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'led', model: 'm' }],
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 2 },
  serviceModel: { provider: 'led', model: 'm' },
  parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1, seed: 3,
} as any;

let dbPath: string;

async function openDb(): Promise<void> {
  dbPath = path.join(os.tmpdir(), `pe-led-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(dbPath);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
}

function insertRun(run: any): void {
  getDatabase().prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
}

async function runToFinish(run: any, config: any = CONFIG): Promise<any> {
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  setSendUpdate(() => {});
  return JSON.parse((getDatabase().prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
}

const freshRun = () => ({ id: 'led-run-' + Math.random().toString(36).slice(2), configId: CONFIG.id,
  startedAt: Date.now(), totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
  generations: [], cacheHits: 0, version: '1.0' });

beforeEach(() => { resetRegistry(); });

describe('spend survives a crash between checkpoints', () => {
  it('a resume adopts spend the checkpoint never recorded', async () => {
    // run.totals lives inside run_json, which persistRun writes — and that
    // write serialises the WHOLE run, so it cannot happen per call. Everything
    // billed after the last checkpoint was rolled back in the accounting but
    // not by the provider, and since budgetUSD is checked against
    // run.totals.usd, every resume re-armed the entire budget. Measured over
    // 8 SIGKILL/resume cycles against a $0.0060 cap: 114 calls really billed,
    // $0.0114 spent, the run reporting 62 calls.
    await openDb();
    registerPriced();
    const run = freshRun();
    insertRun(run);
    const finished = await runToFinish(run);
    expect(finished.totals.usd).toBeGreaterThan(0);

    // Simulate the crash: a checkpoint that is BEHIND what was really billed.
    const stale = JSON.parse(JSON.stringify(finished));
    stale.id = 'led-stale';
    stale.status = 'stopped';
    delete stale.finishedAt; delete stale.stopReason;
    const reallyBilled = { ...finished.totals };
    stale.totals = { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 };
    stale.generations = stale.generations.slice(0, 1);
    insertRun(stale);

    // The sidecar knows what the provider actually charged.
    recordSpend(dbPath, { runId: stale.id, totals: reallyBilled, costBreakdown: finished.costBreakdown, at: Date.now() });

    resetRegistry(); registerPriced();
    const resumed = await runToFinish(stale);
    expect(resumed.totals.usd).toBeGreaterThanOrEqual(reallyBilled.usd);
    expect(resumed.totals.calls).toBeGreaterThanOrEqual(reallyBilled.calls);

    closeDatabase();
    fs.rmSync(dbPath, { force: true });
  }, 120000);

  it('never lets a stale sidecar invent spend', async () => {
    // The larger of (checkpoint, sidecar) wins, so a sidecar left behind by an
    // older, cheaper attempt can only ever under-report.
    await openDb();
    registerPriced();
    const run = freshRun();
    insertRun(run);
    recordSpend(dbPath, {
      runId: run.id,
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
      at: Date.now(),
    });
    const finished = await runToFinish(run);
    expect(finished.totals.usd).toBeCloseTo(finished.totals.calls * USD_PER_CALL, 9);

    closeDatabase();
    fs.rmSync(dbPath, { force: true });
  }, 120000);

  it('clears the sidecar when the run finishes', async () => {
    await openDb();
    registerPriced();
    const run = freshRun();
    insertRun(run);
    await runToFinish(run);
    expect(readSpend(dbPath, run.id)).toBeNull();

    closeDatabase();
    fs.rmSync(dbPath, { force: true });
  }, 120000);
});

describe('spendledger file handling', () => {
  it('round-trips, and reports null for absent or corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-sl-'));
    const db = path.join(dir, 'x.db');
    expect(readSpend(db, 'nope')).toBeNull();

    const snap = { runId: 'r1', totals: { tokensPrompt: 1, tokensCompletion: 2, usd: 0.5, calls: 3 }, at: 123 };
    recordSpend(db, snap);
    expect(readSpend(db, 'r1')).toEqual(snap);

    fs.writeFileSync(path.join(dir, '.spend-r1.json'), '{ truncated');
    expect(readSpend(db, 'r1')).toBeNull();

    clearSpend(db, 'r1');
    expect(readSpend(db, 'r1')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
