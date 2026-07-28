import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { createNextGeneration } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry } from '../../src/registry.js';
import type { CandidateNode } from '../../src/types.js';

const parent = (id: string, fitness: number): CandidateNode => ({
  id, generation: 0, lineageParents: [], status: 'finished', prompt: 'P-' + id,
  params: { model: { provider: 'x', model: 'y' }, temperature: 0.5 },
  changeLog: [], metrics: { fitness, quality: fitness },
} as unknown as CandidateNode);

// Deterministic echo operator that records ctx.rng draws in the changelog
function registerProbe() {
  registerOperator({
    name: 'probe', label: 'Probe', parents: 1,
    description: 'records rng draw',
    async apply(ctx: any) {
      const draw = ctx.rng ? ctx.rng() : -1;
      return {
        prompt: `${ctx.parent.prompt}+${draw.toFixed(6)}`,
        changeLog: [{ label: 'MUTATION', text: `draw ${draw.toFixed(6)}` }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  });
}

const config = (seed?: number) => ({
  id: 'c', name: 'c',
  selection: { policy: 'topk', topK: 3 },
  operators: { mutationShare: 0, crossoverShare: 0, custom: { probe: { share: 1 } } },
  population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
  enabledModels: [{ provider: 'x', model: 'y' }],
  testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
  serviceModel: { provider: 'x', model: 'y' }, parallelLimit: 1,
  serviceModelMaxTokens: 100, retries: 1,
  ...(seed !== undefined ? { seed } : {}),
} as any);

async function lineage(seed?: number) {
  const parents = [parent('a', 9), parent('b', 8), parent('c', 7)];
  const r = await createNextGeneration(parents, parents, 1, config(seed), [parents, []]);
  return r.newNodes.map(n => ({
    prompt: n.prompt,
    parents: n.lineageParents,
    seed: n.params.seed,
    label: n.changeLog[0]?.label,
  }));
}

beforeEach(() => resetRegistry());

describe('seeded generation determinism', () => {
  it('same seed => identical children (prompts, parent assignment, node seeds)', async () => {
    registerProbe();
    const one = await lineage(42);
    resetRegistry(); registerProbe();
    const two = await lineage(42);
    expect(one).toEqual(two);
    expect(one.every(n => typeof n.seed === 'number')).toBe(true); // derived node seeds
  });

  it('different seed => different children', async () => {
    registerProbe();
    const one = await lineage(42);
    resetRegistry(); registerProbe();
    const other = await lineage(43);
    expect(one).not.toEqual(other);
  });

  it('no seed => ctx.rng falls back to Math.random and node seeds stay unset', async () => {
    registerProbe();
    const nodes = await lineage(undefined);
    expect(nodes.every(n => n.seed === undefined)).toBe(true);
  });
});
