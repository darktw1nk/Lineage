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

// Fully deterministic fake adapter: outputs are pure functions of the prompt.
function registerDeterministicAdapter() {
  registerProvider({
    adapter: {
      name: 'det',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
        const p: string = opts.prompt;
        if (p.includes('mutations to improve')) {
          return { ...base, output: '[{"label":"MUTATION","edit":"tweak"}]' };
        }
        if (p.includes('Produce the NEW prompt ONLY')) {
          // Depends on the full apply prompt (which embeds the selected strategies),
          // so different strategy selections yield different child prompts.
          let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
          return { ...base, output: `PROMPT-${(h >>> 0).toString(36)}` };
        }
        return { ...base, output: opts.system ?? p }; // candidate eval: echo
      },
    } as any,
  });
}

function makeConfig(seed?: number) {
  return {
    id: 'seed-cfg', name: 'seed e2e',
    selection: { policy: 'topk', topK: 2 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0,
      paramVariation: { enabled: true, share: 0.5, temperature: { enabled: true, min: 0.2, max: 1.0 } },
    },
    population: { initialSize: 3, generationSize: 4, seedPrompt: 'SEED PROMPT', fill: 'auto' },
    enabledModels: [{ provider: 'det', model: 'm1' }],
    testSet: [
      { id: 't1', name: 'a', mode: 'exact_match', prompt: 'X1', expected: 'X1' },
      { id: 't2', name: 'b', mode: 'exact_match', prompt: 'X2', expected: 'X2' },
      { id: 't3', name: 'c', mode: 'exact_match', prompt: 'X3', expected: 'X3' },
      { id: 't4', name: 'd', mode: 'exact_match', prompt: 'X4', expected: 'X4' },
    ],
    holdoutShare: 0.5,
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'det', model: 'm1' },
    parallelLimit: 3, serviceModelMaxTokens: 100, retries: 1,
    ...(seed !== undefined ? { seed } : {}),
  } as any;
}

// Decision signature: everything the seed promises to reproduce, nothing it doesn't
// (no ids, no timings, no costs).
function signature(events: any[]) {
  const nodeShape = (n: any) => ({
    prompt: n.prompt,
    label: n.changeLog?.[0]?.label,
    temp: n.params?.temperature,
    nodeSeed: n.params?.seed,
    model: n.params?.model?.model,
  });
  // Gen 0 arrives via node_updated; later generations via generation_created.
  // Take the LAST node_updated snapshot per gen-0 prompt slot (post-fill state),
  // keyed by array position in the run's generation 0.
  const gen0ByIndex = new Map<number, any>();
  for (const e of events) {
    if (e.type === 'node_updated' && e.node?.generation === 0) {
      // stable slot: use the node id's first-seen order
      if (![...gen0ByIndex.values()].some(v => v.id === e.node.id)) {
        gen0ByIndex.set(gen0ByIndex.size, { id: e.node.id });
      }
      const slot = [...gen0ByIndex.entries()].find(([, v]) => v.id === e.node.id)![0];
      gen0ByIndex.set(slot, { id: e.node.id, ...nodeShape(e.node) });
    }
  }
  const gens = new Map<number, any[]>();
  for (const e of events) {
    if (e.type === 'generation_created') gens.set(e.generation, e.nodes.map(nodeShape));
  }
  const holdout = events.find(e => e.type === 'holdout_result')?.holdout?.testIds ?? [];
  return {
    holdout,
    gen0: [...gen0ByIndex.values()].map(({ id: _id, ...rest }) => rest),
    later: [...gens.entries()].sort((a, b) => a[0] - b[0]),
  };
}

async function runOnce(seed?: number): Promise<any> {
  const config = makeConfig(seed);
  const tmpDb = path.join(os.tmpdir(), `pe-seed-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run: any = {
    id: 'r-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [], cacheHits: 0, version: '1.0',
  };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, data) => {
    events.push(JSON.parse(JSON.stringify(data)));
    if (data.type === 'status' && data.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return signature(events);
}

beforeEach(() => resetRegistry());

describe('run-level seed reproducibility (E2E)', () => {
  it('same seed => identical decision signature; different seed => different', async () => {
    registerDeterministicAdapter();
    const a = await runOnce(42);
    resetRegistry(); registerDeterministicAdapter();
    const b = await runOnce(42);
    expect(b).toEqual(a);

    resetRegistry(); registerDeterministicAdapter();
    const c = await runOnce(1337);
    expect(c).not.toEqual(a);
  }, 60000);

  it('holdout split follows the run seed, and explicit holdoutSeed wins', async () => {
    registerDeterministicAdapter();
    const a = await runOnce(42);
    // The run had no holdoutSeed, so the split used seed=42:
    const { partitionTestSet } = await import('../../src/engine/holdout.js');
    const direct = partitionTestSet(makeConfig().testSet, 0.5, 42);
    expect(a.holdout).toEqual(direct.holdoutTests.map((t: any) => t.id));
    // Explicit holdoutSeed overrides the run seed:
    const withExplicit = partitionTestSet(makeConfig().testSet, 0.5, 7);
    expect(withExplicit.holdoutTests.map((t: any) => t.id)).not.toEqual(a.holdout);
  }, 60000);

  it('unseeded run completes with node seeds unset (Math.random paths intact)', async () => {
    registerDeterministicAdapter();
    const sig = await runOnce(undefined);
    expect(sig.gen0.length).toBeGreaterThan(0);
    expect(sig.gen0.every((n: any) => n.nodeSeed === undefined)).toBe(true);
    expect(sig.later.every(([, nodes]: any) => nodes.every((n: any) => n.nodeSeed === undefined))).toBe(true);
  }, 60000);
});
