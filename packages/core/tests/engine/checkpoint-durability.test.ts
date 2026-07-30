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
import { readSpend } from '../../src/engine/spendledger.js';

/**
 * docs/cli.md promises "if the process dies, nothing is lost". Nothing tested
 * the three mechanisms that make that true: the FINAL checkpoint being flushed
 * rather than debounced, the per-accrual spend sidecar, and the
 * `lastCheckpointAt` stamp that resume uses to credit process downtime.
 * All three could be removed with 595 tests still green.
 */
let dbPath = '';
let sidecarDuringRun: ReturnType<typeof readSpend> = null;

function registerAdapter(onCall?: () => void) {
  registerProvider({
    adapter: {
      name: 'ckpt',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        onCall?.();
        return { output: opts.system ?? opts.prompt, promptTokens: 3, completionTokens: 2, latencyMs: 1, usd: 0.001 };
      },
    } as any,
  });
}

const CONFIG = {
  id: 'ck-cfg', name: 'checkpoint durability',
  selection: { policy: 'topk', topK: 1 },
  operators: { mutationShare: 0, crossoverShare: 0 },
  population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'ckpt', model: 'm' }],
  testSet: [
    { id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'SEED' },
    { id: 't2', name: 'b', mode: 'exact_match', prompt: 'B', expected: 'SEED' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'ckpt', model: 'm' },
  parallelLimit: 1, samplesPerTest: 1, serviceModelMaxTokens: 100, retries: 1,
} as any;

async function openDb() {
  dbPath = path.join(os.tmpdir(), `pe-ck-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(dbPath);
  getDatabase().prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(CONFIG.id, CONFIG.name, JSON.stringify(CONFIG), Date.now());
}

function insertRun(run: any) {
  getDatabase().prepare('INSERT OR REPLACE INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
}

const freshRun = (over: any = {}) => ({
  id: 'ck-run-' + Math.random().toString(36).slice(2), configId: CONFIG.id, startedAt: Date.now(),
  totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
  generations: [], cacheHits: 0, version: '1.0', ...over,
});

async function runToFinish(run: any, config = CONFIG) {
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  setSendUpdate(() => {});
  return JSON.parse((getDatabase().prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
}

function cleanup() {
  try { closeDatabase(); } catch { /* already closed */ }
  for (const p of [dbPath, `${dbPath}.lock`, `${dbPath}.tmp`]) fs.rmSync(p, { force: true });
  for (const f of fs.readdirSync(path.dirname(dbPath)).filter(f => f.startsWith('.spend-ck-run-'))) {
    fs.rmSync(path.join(path.dirname(dbPath), f), { force: true });
  }
}

beforeEach(() => { resetRegistry(); sidecarDuringRun = null; });

describe('the checkpoint reaches disk, not just memory', () => {
  it('the FINAL checkpoint is on disk before the run reports finished', async () => {
    // persistRun's `durable` flag skips the 50ms debounce and fsyncs. Without
    // it a hard crash inside that window loses the last checkpoint, and a
    // completed run reappears as interrupted so --resume pays for it twice.
    // Read the FILE, not the handle: the handle would answer from memory.
    await openDb();
    registerAdapter();
    const run = freshRun();
    insertRun(run);
    await runToFinish(run);

    const onDisk = fs.readFileSync(dbPath).toString('latin1');
    expect(onDisk).toContain(run.id);
    expect(onDisk).toContain('"status":"finished"');
    expect(onDisk).toContain('"stopReason":"generations"');
    cleanup();
  }, 60000);

  it('writes finished_at and stop_reason as COLUMNS, not only inside run_json', async () => {
    // Any SQL consumer reading these columns would otherwise see "no run ever
    // finished" — they were NULL for every real run.
    await openDb();
    registerAdapter();
    const run = freshRun();
    insertRun(run);
    await runToFinish(run);

    const row = getDatabase()
      .prepare('SELECT finished_at, stop_reason FROM evaluation_runs WHERE id = ?').get(run.id) as any;
    expect(row.stop_reason).toBe('generations');
    expect(typeof row.finished_at).toBe('number');
    expect(row.finished_at).toBeGreaterThan(0);
    cleanup();
  }, 60000);

  it('stamps lastCheckpointAt on every checkpoint', async () => {
    // resume credits process downtime as paused time, measured from
    // lastCheckpointAt. Without the stamp it falls back to startedAt and a run
    // resumed the next morning dies instantly on timeLimitMs.
    await openDb();
    registerAdapter();
    const run = freshRun();
    insertRun(run);
    const before = Date.now();
    const final = await runToFinish(run);
    expect(final.lastCheckpointAt).toBeGreaterThanOrEqual(before);
    cleanup();
  }, 60000);
});

describe('the spend sidecar is written as the money is spent', () => {
  it('exists DURING the run, not only after it', async () => {
    // The sidecar is the only record of spend between two checkpoints. All
    // three existing spend-ledger tests write it by hand, so removing the
    // engine's own recordSpend call left them green: the "cleared on finish"
    // assertion passes trivially for a file that was never created.
    await openDb();
    const run = freshRun();
    insertRun(run);
    let calls = 0;
    registerAdapter(() => {
      // Read it after the FIRST call has been billed but long before the run ends.
      if (++calls === 2 && sidecarDuringRun === null) sidecarDuringRun = readSpend(dbPath, run.id);
    });
    await runToFinish(run);

    expect(sidecarDuringRun).not.toBeNull();
    expect(sidecarDuringRun!.totals.calls).toBeGreaterThan(0);
    expect(sidecarDuringRun!.totals.usd).toBeGreaterThan(0);
    // …and it is cleared once the checkpoint is authoritative.
    expect(readSpend(dbPath, run.id)).toBeNull();
    cleanup();
  }, 60000);
});

describe('resume credits the time the process was dead', () => {
  it('a run whose checkpoint is an hour old is not killed on arrival by timeLimitMs', async () => {
    // timeLimitMs is measured from run.startedAt minus paused time, and the gap
    // between a crash and a --resume was recorded nowhere — so a run resumed the
    // next morning stopped instantly with stopReason 'time', having done no work.
    await openDb();
    registerAdapter();
    const HOUR = 60 * 60 * 1000;
    const run = freshRun({
      startedAt: Date.now() - HOUR,
      lastCheckpointAt: Date.now() - HOUR + 1000, // alive an hour ago
      status: 'stopped',
      generations: [[{
        id: 'n0', generation: 0, lineageParents: [], status: 'awaiting', prompt: 'SEED',
        params: { model: { provider: 'ckpt', model: 'm' }, temperature: 0.7 },
        changeLog: [{ label: 'MUTATION', text: 'Seed prompt (baseline)' }],
      }]],
    });
    insertRun(run);

    const final = await runToFinish(run, { ...CONFIG, targets: { maxGenerations: 1, timeLimitMs: 60_000 } });

    expect(final.stopReason).not.toBe('time');
    expect(final.generations[0][0].status).toBe('finished');
    // The downtime was credited, not charged against the limit.
    expect(final.totalPausedMs).toBeGreaterThan(HOUR - 60_000);
    cleanup();
  }, 60000);
});
