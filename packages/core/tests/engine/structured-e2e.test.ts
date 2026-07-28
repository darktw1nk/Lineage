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

let adapterCalls = 0;

// Echoes the candidate (system) prompt for plain tests; always calls get_weather
// with {city: 'Paris'} when tools are offered.
function registerToolAdapter() {
  registerProvider({
    adapter: {
      name: 'tooly',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        adapterCalls++;
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
        if (opts.tools?.length) {
          return { ...base, output: '', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
        }
        return { ...base, output: opts.system ?? opts.prompt };
      },
    } as any,
  });
}

const TOOLS = [
  { name: 'get_weather', parameters: { type: 'object' } },
  { name: 'get_time', parameters: { type: 'object' } },
];

const config = {
  id: 'st-cfg', name: 'structured e2e',
  selection: { policy: 'topk', topK: 1 },
  operators: { mutationShare: 0, crossoverShare: 0 },
  population: { initialSize: 1, generationSize: 1, seedPrompt: '{"name":"Bob","email":"b@x.co"}', fill: 'auto' },
  enabledModels: [{ provider: 'tooly', model: 'm1' }],
  testSet: [
    { id: 's1', name: 'schema', mode: 'json_schema', prompt: 'Extract the contact.',
      schema: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' } } } },
    { id: 'w1', name: 'weather', mode: 'tool_call', prompt: 'Weather in Paris?',
      tools: TOOLS, expectedTool: { name: 'get_weather', args: { city: 'Paris' } } },
    { id: 't1', name: 'time', mode: 'tool_call', prompt: 'Time in Oslo?',
      tools: TOOLS, expectedTool: { name: 'get_time' } },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'tooly', model: 'm1' },
  parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
} as any;

beforeEach(() => { resetRegistry(); adapterCalls = 0; });

describe('structured test modes end-to-end', () => {
  it('scores json_schema and tool_call deterministically with zero judge calls', async () => {
    registerToolAdapter();
    const tmpDb = path.join(os.tmpdir(), `pe-st-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = { id: 'st-run', configId: config.id, startedAt: Date.now(),
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

    const node = events.filter(e => e.type === 'node_updated').map(e => e.node)
      .reverse().find((n: any) => n.tests?.length === 3);
    expect(node).toBeDefined();
    const byId = Object.fromEntries(node.tests.map((t: any) => [t.testId, t]));

    // json_schema: seed prompt echoes back as conformant JSON
    expect(byId.s1.score).toBe(10);
    expect(byId.s1.passed).toBe(true);

    // tool_call, matching tool + args
    expect(byId.w1.score).toBe(10);
    expect(JSON.parse(byId.w1.outputText).toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(byId.w1.llmGradeReasoning).toMatch(/matching args/);

    // tool_call, wrong tool (adapter always calls get_weather)
    expect(byId.t1.score).toBe(2);
    expect(byId.t1.llmGradeReasoning).toMatch(/expected get_time/);

    // Deterministic scoring: exactly 3 adapter calls (candidate evals), zero judge calls
    expect(adapterCalls).toBe(3);

    // Node quality is the mean of the deterministic scores
    expect(node.metrics.quality).toBeCloseTo((10 + 10 + 2) / 3, 5);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 30000);
});
