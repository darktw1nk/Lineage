import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { scoreJsonSchema, resetStructuredWarnings } from '../../src/engine/structured.js';
import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';

/**
 * Open-bugs 2026-07-31 #4: the whole warnConfigErrorOnce / keyed-Set /
 * resetStructuredWarnings change had NO coverage — reverting it wholesale,
 * un-keying the Set, or unwiring the reset all left the suite green.
 *
 * What the change promises:
 *  - each broken json_schema test warns ONCE per run, naming the test —
 *    an unkeyed boolean warned only for the first broken test and named none;
 *  - the reset is wired at run start, so a SECOND run in the same long-lived
 *    process (the Electron main process) warns again instead of being silent.
 */
const SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
};
// Does not conform to its own schema (name must be a string) — the config
// error the warning exists for.
const BAD_EXPECTED = '{"name": 42}';

const configWarnings = () =>
  (console.warn as any).mock.calls
    .map((c: any[]) => c.join(' '))
    .filter((m: string) => /CONFIG ERROR in test/.test(m));

describe('warnConfigErrorOnce (unit)', () => {
  beforeEach(() => {
    resetStructuredWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once per test, naming the test key', () => {
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-A', BAD_EXPECTED);
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-A', BAD_EXPECTED);
    const warnings = configWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('test-A');
  });

  it('a SECOND broken test warns too, naming itself — the Set is keyed', () => {
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-A', BAD_EXPECTED);
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-B', BAD_EXPECTED);
    const warnings = configWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('test-B');
  });

  it('resetStructuredWarnings re-arms a key that already warned', () => {
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-A', BAD_EXPECTED);
    resetStructuredWarnings();
    scoreJsonSchema('{"name":"x"}', SCHEMA, 'test-A', BAD_EXPECTED);
    expect(configWarnings()).toHaveLength(2);
  });
});

/** The wiring: startEvaluation must reset the warned set at the start of EVERY run. */
describe('the config-error warning fires per RUN, not per process', () => {
  const config = {
    id: 'sw-cfg', name: 'structured warnings',
    selection: { policy: 'topk', topK: 1 },
    operators: { mutationShare: 0, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'echoey', model: 'm1' }],
    testSet: [
      { id: 'bad-1', name: 'broken one', mode: 'json_schema', prompt: 'X', schema: SCHEMA, expected: BAD_EXPECTED },
      { id: 'bad-2', name: 'broken two', mode: 'json_schema', prompt: 'Y', schema: SCHEMA, expected: BAD_EXPECTED },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'echoey', model: 'm1' },
    parallelLimit: 1, samplesPerTest: 1,
    serviceModelMaxTokens: 100, retries: 1,
  } as any;

  async function runOnce(dbPath: string, runId: string) {
    await initializeDatabase(dbPath);
    const db = getDatabase();
    if (!db.prepare('SELECT id FROM evaluation_configs WHERE id = ?').get(config.id)) {
      db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
        .run(config.id, config.name, JSON.stringify(config), Date.now());
    }
    const run: any = { id: runId, configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    const done = new Promise<void>(res => setSendUpdate((_id, d: any) => {
      if (d.type === 'status' && d.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    await done;
    closeDatabase();
    setSendUpdate(() => {});
  }

  beforeEach(() => {
    resetRegistry();
    registerProvider({ adapter: {
      name: 'echoey',
      estimateTokens: () => ({ prompt: 10 }),
      call: async () => ({
        output: '{"name":"x"}', promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: 0.0001,
      }),
    } as any });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns for each broken test in run 1, and AGAIN in run 2 of the same process', async () => {
    const tmpDb = path.join(os.tmpdir(), `pe-sw-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

    await runOnce(tmpDb, 'sw-run-1');
    const firstRun = configWarnings();
    // Both broken tests, each named — an unkeyed guard warns once and names neither.
    expect(firstRun.some((m: string) => m.includes('bad-1'))).toBe(true);
    expect(firstRun.some((m: string) => m.includes('bad-2'))).toBe(true);
    expect(firstRun).toHaveLength(2);

    (console.warn as any).mockClear();
    await runOnce(tmpDb, 'sw-run-2');
    const secondRun = configWarnings();
    // The Electron main process runs many evaluations; without the reset
    // wired at run start, the second run's config error is silent.
    expect(secondRun.some((m: string) => m.includes('bad-1'))).toBe(true);
    expect(secondRun.some((m: string) => m.includes('bad-2'))).toBe(true);

    fs.rmSync(tmpDb, { force: true });
  }, 60000);
});
