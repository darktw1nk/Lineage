import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({ store: { get: () => null, set: () => {}, store: {} }, setStore: vi.fn() }));
vi.mock('../../src/providers/index.js', () => {
  let n = 0;
  return {
    getProviderAdapter: () => ({
      name: 'openai', estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => ({
        output: /propose mutations/i.test(opts.prompt)
          ? '[{"label":"MUTATION","edit":"tighten it"}]'
          : `child variant ${++n}`,
        promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0,
      }),
    }),
  };
});

import { estimateRunCost } from '../../src/engine/estimate.js';
import type { ModelRef, ModelCostEntry } from '../../src/types.js';

/**
 * Adaptive sizing has to stay honest with the two things that quote or cap
 * spend, or it becomes a way to quietly overspend:
 *
 *  1. The COST ESTIMATE. A run that may widen to `populationRange.max` must be
 *     quoted at that width. Quoting the nominal `generationSize` would
 *     under-bill every adaptive run by exactly the growth factor — the failure
 *     mode the estimator exists to prevent.
 *  2. The GENERATION ITSELF. The size the engine actually builds must follow
 *     the range, or the feature is decoration.
 */
const flatCost = async (m: ModelRef): Promise<ModelCostEntry | null> => ({
  provider: m.provider, model: m.model, promptUSDper1k: 0.001, completionUSDper1k: 0.002,
});

const base = (population: any = {}) => ({
  id: 'e', name: 'e',
  selection: { policy: 'topk', topK: 2, eliteShare: 0 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 4, generationSize: 4, seedPrompt: 'SEED '.repeat(20), fill: 'auto', ...population },
  enabledModels: [{ provider: 'x', model: 'm1' }],
  serviceModel: { provider: 'x', model: 'svc' },
  testSet: [{ id: 't1', name: 'a', mode: 'llm_grade', prompt: 'P'.repeat(200) }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 3 },
  serviceModelMaxTokens: 20000, retries: 1, parallelLimit: 2,
} as any);

describe('the cost estimate quotes the widest generation the engine may run', () => {
  it('quotes more when the range allows growth above generationSize', async () => {
    const fixed = await estimateRunCost(base(), flatCost);
    const adaptive = await estimateRunCost(base({ populationRange: { min: 2, max: 10 } }), flatCost);
    expect(adaptive.calls).toBeGreaterThan(fixed.calls);
    expect(adaptive.high).toBeGreaterThan(fixed.high);
  });

  it('does not inflate the quote when the range cannot exceed generationSize', async () => {
    const fixed = await estimateRunCost(base(), flatCost);
    const capped = await estimateRunCost(base({ populationRange: { min: 2, max: 4 } }), flatCost);
    expect(capped.calls).toBe(fixed.calls);
  });

  it('is unchanged when no range is configured', async () => {
    const a = await estimateRunCost(base(), flatCost);
    const b = await estimateRunCost(base({ populationRange: undefined }), flatCost);
    expect(a.calls).toBe(b.calls);
  });

  it('ignores a malformed range rather than quoting nonsense', async () => {
    // `max` must sit ABOVE generationSize to discriminate: with max below it,
    // the Math.max floor produces the right answer whether or not the
    // malformed-range guard exists, and the test proves nothing.
    // The engine disables itself on a malformed range, so the estimate must
    // too — otherwise the quote and the run disagree in opposite directions.
    const fixed = await estimateRunCost(base(), flatCost);
    const broken = await estimateRunCost(base({ populationRange: { min: 20, max: 12 } }), flatCost);
    expect(broken.calls).toBe(fixed.calls);
  });
});

/**
 * WIRING. Every pure-function test passes even if `createNextGeneration` never
 * calls `adaptiveGenerationSize`. This drives the real transition.
 */
describe('the generation the engine builds follows the range', () => {
  const node = (id: string, prompt: string, fitness: number): any => ({
    id, generation: 0, lineageParents: [], status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  });

  const cfg = (populationRange?: { min: number; max: number }): any => ({
    id: 'c', name: 'adaptive wiring',
    selection: { policy: 'topk', topK: 2, eliteShare: 0 },
    operators: {
      mutationShare: 1, crossoverShare: 0,
      metaPrompting: { enabled: false, share: 0 },
      paramVariation: { enabled: false, share: 0 },
      modelVariation: { enabled: false, share: 0 },
    },
    population: {
      initialSize: 8, generationSize: 8, seedPrompt: 'THE ORIGINAL SEED PROMPT', fill: 'auto',
      ...(populationRange ? { populationRange } : {}),
    },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 4, serviceModelMaxTokens: 100, retries: 1,
  });

  /** Every generation peaks at 7.0 — the search has stopped paying. */
  const flatHistory = () => {
    const gen = (n: number) => [node(`a${n}`, `converged prompt ${n}`, 7), node(`b${n}`, `converged ${n}b`, 6)];
    return [gen(0), gen(1), gen(2)];
  };
  /** Each generation better than the last — the search is paying off. */
  const risingHistory = () => [
    [node('a0', 'p0', 2), node('b0', 'p0b', 1)],
    [node('a1', 'p1', 5), node('b1', 'p1b', 4)],
    [node('a2', 'p2', 9), node('b2', 'p2b', 8)],
  ];

  async function sizeOf(history: any[][], populationRange?: { min: number; max: number }) {
    const { createNextGeneration } = await import('../../src/engine/generation.js');
    const parents = history[history.length - 1];
    const { newNodes } = await createNextGeneration(parents, parents, 3, cfg(populationRange), history);
    return newNodes.length;
  }

  it('builds exactly generationSize when no range is configured', async () => {
    expect(await sizeOf(flatHistory())).toBe(8);
    expect(await sizeOf(risingHistory())).toBe(8);
  });

  it('shrinks a plateaued generation below the configured size', async () => {
    const n = await sizeOf(flatHistory(), { min: 3, max: 12 });
    expect(n).toBeLessThan(8);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('widens a fast-improving generation above the configured size', async () => {
    const n = await sizeOf(risingHistory(), { min: 3, max: 12 });
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThanOrEqual(12);
  });

  it('never exceeds the ceiling the user set', async () => {
    const n = await sizeOf(risingHistory(), { min: 3, max: 9 });
    expect(n).toBeLessThanOrEqual(9);
  });
});
