import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadPlugins } from '../src/pluginLoader.js';
import { getOperator, resetRegistry } from '../src/registry.js';
import { getProviderAdapter } from '../src/providers/index.js';
import {
  initializeDatabase, closeDatabase, getDatabase, setStore, setSendUpdate, startEvaluation,
} from '../src/index.js';
import type { CandidateNode, EvaluationConfig } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(HERE, '..', '..', '..', 'examples', 'plugins');
const FIXTURES = path.join(HERE, 'fixtures', 'plugins');

beforeEach(() => resetRegistry());

describe('example plugins', () => {
  it('section-shuffle rotates sections deterministically', async () => {
    const manifests = await loadPlugins({ paths: [path.join(EXAMPLES, 'section-shuffle.mjs')] });
    expect(manifests[0].error).toBeUndefined();

    const op = getOperator('section-shuffle')!;
    const parent = { prompt: 'A\n\nB\n\nC', params: { model: { provider: 'x', model: 'y' }, temperature: 0.7 } } as CandidateNode;
    const result = await op.apply({ parent, config: {} as EvaluationConfig, generation: [] });
    expect(result.prompt).toBe('B\n\nC\n\nA');
  });

  it('ollama adapter parses OpenAI-compatible responses', async () => {
    const manifests = await loadPlugins({ paths: [path.join(EXAMPLES, 'ollama', 'index.mjs')] });
    expect(manifests[0].error).toBeUndefined();

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'hello from llama' } }],
      usage: { prompt_tokens: 7, completion_tokens: 4 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const adapter = getProviderAdapter('ollama');
      const result = await adapter.call({ model: 'llama3.2', prompt: 'hi', temperature: 0.5, maxTokens: 100 });
      expect(result.output).toBe('hello from llama');
      expect(result.promptTokens).toBe(7);
      expect(result.usd).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('end-to-end evolution via plugins', () => {
  const tmpDb = path.join(os.tmpdir(), `pe-plugin-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

  it('evolves with the echo provider and section-shuffle operator only', async () => {
    setStore({ get: () => null, set: () => {}, store: {} });
    await loadPlugins({
      paths: [
        path.join(EXAMPLES, 'section-shuffle.mjs'),
        // echo provider fixture from the loader tests
        path.join(FIXTURES, 'valid-provider.mjs'),
      ],
    });
    await initializeDatabase(tmpDb);

    const config = {
      id: 'e2e-cfg', name: 'plugin e2e',
      selection: { policy: 'topk', topK: 1 },
      operators: { mutationShare: 0, crossoverShare: 0, custom: { 'section-shuffle': { share: 1 } } },
      population: { initialSize: 1, generationSize: 1, seedPrompt: 'Alpha\n\nBeta', fill: 'auto' },
      enabledModels: [{ provider: 'echo', model: 'echo-1' }],
      testSet: [{ id: 't1', name: 'echo test', mode: 'exact_match', prompt: 'ping', expected: 'anything' }],
      fitness: { weights: { quality: 1 } },
      targets: { maxGenerations: 2 },
      serviceModel: { provider: 'echo', model: 'echo-1' },
      parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
    } as any;

    const events: any[] = [];
    const finished = new Promise<void>((resolve) => {
      setSendUpdate((_runId, data) => {
        events.push(data);
        if (data.type === 'status' && data.status === 'finished') resolve();
      });
    });

    const run = {
      id: 'e2e-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
      generations: [], cacheHits: 0, version: '1.0',
    } as any;
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    await startEvaluation(run.id, config, run);
    await finished;

    const nodes = events.filter(e => e.type === 'node_updated').map(e => e.node);
    const gen1 = nodes.filter(n => n.generation === 1);
    expect(gen1.length).toBeGreaterThan(0);
    expect(gen1.some(n => n.changeLog.some((c: any) => c.label === 'SECTION-SHUFFLE'))).toBe(true);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 20000);
});
