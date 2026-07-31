/**
 * IPC handler integration tests: real sql.js database, mocked Electron shell.
 * Covers the roadmap's "IPC round-trip" and "Database CRUD" integration items.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Mock the electron shell (logger imports BrowserWindow; handlers dynamic-import dialog/app only for export/import, which we don't test here)
// `app.isPackaged` gates the dev-only IPC handler (NODE_ENV cannot be used —
// vite-plugin-electron blocks its static replacement, so the check survived
// into packaged builds). Report packaged so tests exercise the shipped surface.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {},
  app: { isPackaged: true, getPath: () => '/tmp' },
}));

// Partial-mock core: real database + costs, mocked store + evaluator entry points
// (vi.hoisted because the vi.mock factory is hoisted above normal declarations)
const { storeBacking, storeDelete, startEvalSpy } = vi.hoisted(() => {
  const backing: Record<string, any> = {};
  return {
    storeBacking: backing,
    storeDelete: vi.fn((key: string) => { delete backing[key]; }),
    startEvalSpy: vi.fn(),
  };
});

vi.mock('@lineage/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lineage/core')>();
  return {
    ...actual,
    store: {
      get: (k: string) => storeBacking[k] ?? null,
      set: (k: string, v: any) => { storeBacking[k] = v; },
      delete: storeDelete,
      get store() { return storeBacking; },
    },
    setSendUpdate: vi.fn(),
    startEvaluation: startEvalSpy,
    pauseEvaluation: vi.fn(),
    resumeEvaluation: vi.fn(),
    stopEvaluation: vi.fn(),
  };
});

import { registerIPCHandlers } from '../../electron/ipc/handlers';
import { initializeDatabase, closeDatabase } from '@lineage/core';

// Mock IpcMain that records handlers for direct invocation
const channels = new Map<string, (...args: any[]) => Promise<any>>();
const mockIpcMain = {
  handle: vi.fn((channel: string, fn: any) => { channels.set(channel, fn); }),
} as any;

const invoke = (channel: string, ...args: any[]) => {
  const fn = channels.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return fn({} as any, ...args);
};

const tmpDb = path.join(os.tmpdir(), `pe-ipc-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

function makeConfig(id = 'cfg-abc'): any {
  return {
    id,
    name: 'IPC test config',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: { initialSize: 2, generationSize: 2, seedPrompt: 'seed', fill: 'auto' },
    enabledModels: [{ provider: 'gemini', model: 'gemini-2.5-flash-lite' }],
    testSet: [],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
    parallelLimit: 1,
    serviceModelMaxTokens: 1000,
    retries: 1,
  };
}

beforeAll(async () => {
  await initializeDatabase(tmpDb);
  registerIPCHandlers(mockIpcMain);
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
});

describe('handler registration', () => {
  it('registers the full IPC surface', () => {
    for (const ch of [
      'eval:create', 'eval:start', 'eval:pause', 'eval:resume', 'eval:stop',
      'eval:list', 'eval:export', 'eval:import', 'eval:delete', 'eval:getConfig',
      // 'keys:debug' deliberately absent: it returned every decrypted secret to
      // the renderer and had no caller.
      'settings:get', 'settings:set', 'keys:save', 'keys:get', 'keys:test',
      'costs:get', 'costs:set', 'costs:getAll',
      'models:fetch-openrouter', 'models:sync-openrouter',
      'systemPrompts:get', 'systemPrompts:set', 'logs:getBuffer',
    ]) {
      expect(channels.has(ch), `missing handler: ${ch}`).toBe(true);
    }
  });
});

describe('evaluation CRUD round-trip', () => {
  it('creates, lists, reads config, and deletes an evaluation', async () => {
    const run = await invoke('eval:create', makeConfig());
    expect(run.id).toBeTruthy();
    expect(run.configId).toBe('cfg-abc');
    // Preflight estimate stamped at creation (models may be uncatalogued in the
    // test DB — prices are then $0, but the call count is always positive)
    expect(run.estimate?.calls).toBeGreaterThan(0);

    const list = await invoke('eval:list');
    expect(list.some((r: any) => r.id === run.id)).toBe(true);
    expect(list.find((r: any) => r.id === run.id).configName).toBe('IPC test config');
    // Never-started run (no status, not active in this process) => resumable
    expect(list.find((r: any) => r.id === run.id).interrupted).toBe(true);

    // Finished runs are NOT interrupted
    const { getDatabase } = await import('@lineage/core');
    const db = getDatabase();
    const row = db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any;
    const finishedRun = { ...JSON.parse(row.run_json), status: 'finished' };
    db.prepare('UPDATE evaluation_runs SET run_json = ? WHERE id = ?').run(JSON.stringify(finishedRun), run.id);
    const list2 = await invoke('eval:list');
    expect(list2.find((r: any) => r.id === run.id).interrupted).toBe(false);

    const config = await invoke('eval:getConfig', run.id);
    expect(config.name).toBe('IPC test config');
    expect(config.population.seedPrompt).toBe('seed');

    await invoke('eval:delete', run.id);
    const after = await invoke('eval:list');
    expect(after.some((r: any) => r.id === run.id)).toBe(false);
    expect(await invoke('eval:getConfig', run.id)).toBeNull();
  });

  it('eval:estimate returns a cost estimate without creating a run', async () => {
    const before = (await invoke('eval:list')).length;
    const est = await invoke('eval:estimate', makeConfig('cfg-est'));
    expect(est.calls).toBeGreaterThan(0);
    expect(est.low).toBeLessThanOrEqual(est.high);
    expect(Array.isArray(est.breakdown)).toBe(true);
    expect((await invoke('eval:list')).length).toBe(before); // no run row
  });

  it('resolves config id collisions by generating a fresh id', async () => {
    const first = await invoke('eval:create', makeConfig('cfg-dup'));
    const second = await invoke('eval:create', makeConfig('cfg-dup')); // same id — must not throw

    expect(second.configId).not.toBe('cfg-dup');
    expect(first.configId).toBe('cfg-dup');

    await invoke('eval:delete', first.id);
    await invoke('eval:delete', second.id);
  });

  it('eval:start on an unknown run rejects', async () => {
    await expect(invoke('eval:start', 'no-such-run')).rejects.toThrow(/not found/i);
    expect(startEvalSpy).not.toHaveBeenCalled();
  });
});

describe('settings round-trip', () => {
  it('returns defaults seeded from the model catalog when unset', async () => {
    const settings = await invoke('settings:get');
    expect(settings.globalParallelLimit).toBe(5);
    expect(settings.serviceModel.model).toBeTruthy(); // auto-selected from seeded catalog
  });

  it('persists and returns updated settings', async () => {
    const settings = await invoke('settings:get');
    await invoke('settings:set', { ...settings, globalParallelLimit: 9 });
    const after = await invoke('settings:get');
    expect(after.globalParallelLimit).toBe(9);
  });
});

describe('API key handlers', () => {
  it('saves keys under apiKey.<provider>', async () => {
    await invoke('keys:save', 'gemini', 'test-key-123');
    expect(storeBacking['apiKey.gemini']).toBe('test-key-123');
    expect(await invoke('keys:get', 'gemini')).toBeTruthy();
  });

  it('deletes the stored key when saving an empty value', async () => {
    await invoke('keys:save', 'gemini', '  ');
    expect(storeDelete).toHaveBeenCalledWith('apiKey.gemini');
  });
});

describe('model cost handlers', () => {
  it('exposes the seeded catalog and accepts new entries', async () => {
    const all = await invoke('costs:getAll');
    expect(all.some((e: any) => e.model === 'gemini-2.5-flash-lite')).toBe(true);

    await invoke('costs:set', { provider: 'groq', model: 'test-model-x', promptUSDper1k: 0.001, completionUSDper1k: 0.002 });
    const entry = await invoke('costs:get', { provider: 'groq', model: 'test-model-x' });
    expect(entry.promptUSDper1k).toBeCloseTo(0.001, 10);
  });

  it('hides catalog rows with NEGATIVE stored prices instead of offering them', async () => {
    // Write-side guards (validateModelCost, the OpenRouter "-1" sentinel
    // filter) only protect rows written after they existed. Rows synced
    // earlier are in real databases today: the model list showed
    // `openrouter/auto` at -$1,000,000 and let it be selected, which inverts
    // fitness and disarms budgetUSD. The READ path must refuse them too.
    const { getDatabase } = await import('@lineage/core');
    const db = getDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
      VALUES ('openrouter', 'openrouter/auto', -1000, -1000)
    `).run();

    const all = await invoke('costs:getAll');
    expect(all.some((e: any) => e.model === 'openrouter/auto')).toBe(false);
    expect(all.every((e: any) => e.promptUSDper1k >= 0 && e.completionUSDper1k >= 0)).toBe(true);

    // A direct lookup must not hand a negative price to fitness or the estimator.
    expect(await invoke('costs:get', { provider: 'openrouter', model: 'openrouter/auto' })).toBeNull();
  });
});
