import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
// The real operators call a service model; stub it so the transition runs
// offline. Each operator returns a DISTINCT prompt, otherwise the chokepoint
// records a no-op carry and no operator gets credit.
vi.mock('../../src/providers/index.js', () => {
  let n = 0;
  return {
    getProviderAdapter: () => ({
      name: 'openai',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => ({
        output: /propose mutations|surgeon/i.test(opts.prompt)
          ? '[{"label":"MUTATION","edit":"tighten the wording"}]'
          : `rewritten prompt variant ${++n}`,
        promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0,
      }),
    }),
  };
});

import { adaptOperatorShares } from '../../src/engine/generation.js';

/**
 * Adaptive operator rates.
 *
 * The engine already measures what each operator is worth — average fitness
 * delta from parent to child — and then throws the number away in a console
 * line. Feeding it back means an operator that keeps producing better children
 * earns more of the next generation's budget, and one that keeps producing
 * worse ones earns less. That is a textbook adaptive GA, and the data was
 * already being collected.
 *
 * Rules the implementation must honour:
 *  - OFF by default: `adaptivity: 0` reproduces the configured shares exactly.
 *  - No operator is ever starved to zero while adaptivity < 1 — a bad early
 *    sample must not permanently remove an operator from the search.
 *  - Operators with no measurements yet keep their configured share; they
 *    cannot be judged on evidence that does not exist.
 *  - Shares stay normalized, so downstream child-count maths is unchanged.
 */
const shares = (o: Record<string, number>) => new Map(Object.entries(o));
const stats = (o: Record<string, [number, number]>) =>
  Object.fromEntries(Object.entries(o).map(([k, [totalDelta, count]]) => [k, { totalDelta, count }]));

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('adaptivity 0 changes nothing', () => {
  it('returns the configured shares unchanged', () => {
    const base = shares({ mutation: 0.5, crossover: 0.3, meta: 0.2 });
    const out = adaptOperatorShares(base, stats({ mutation: [10, 5], crossover: [-5, 5] }), 0);
    expect(Object.fromEntries(out)).toEqual({ mutation: 0.5, crossover: 0.3, meta: 0.2 });
  });

  it('returns the configured shares when there is no evidence at all', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    const out = adaptOperatorShares(base, {}, 0.5);
    expect(Object.fromEntries(out)).toEqual({ mutation: 0.5, crossover: 0.5 });
  });
});

describe('adaptivity > 0 rewards what is working', () => {
  it('gives the better operator a larger share than the worse one', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    const out = adaptOperatorShares(
      base,
      stats({ mutation: [10, 5] /* avgΔ +2.0 */, crossover: [-10, 5] /* avgΔ -2.0 */ }),
      0.5,
    );
    expect(out.get('mutation')!).toBeGreaterThan(out.get('crossover')!);
  });

  it('keeps the shares normalized so child counts are unaffected', () => {
    const base = shares({ mutation: 0.4, crossover: 0.3, meta: 0.3 });
    const out = adaptOperatorShares(
      base, stats({ mutation: [8, 4], crossover: [-4, 4], meta: [0, 2] }), 0.7,
    );
    expect(sum(out)).toBeCloseTo(sum(base), 10);
  });

  it('never starves an operator to zero below full adaptivity', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    const out = adaptOperatorShares(
      base, stats({ mutation: [50, 5], crossover: [-50, 5] }), 0.9,
    );
    expect(out.get('crossover')!).toBeGreaterThan(0);
  });

  it('leaves an operator with no measurements between the measured ones', () => {
    // meta has no samples, so it is neither rewarded nor punished: its share is
    // carried through the re-weighting untouched and only the final
    // renormalization moves it, which lands it between the winner and loser.
    const base = shares({ mutation: 0.5, crossover: 0.25, meta: 0.25 });
    const out = adaptOperatorShares(base, stats({ mutation: [10, 5], crossover: [-10, 5] }), 0.5);
    const ratio = (name: string) => out.get(name)! / base.get(name)!;
    expect(ratio('mutation')).toBeGreaterThan(ratio('meta'));
    expect(ratio('meta')).toBeGreaterThan(ratio('crossover'));
  });

  it('ignores an operator whose share is already 0', () => {
    const base = shares({ mutation: 1, crossover: 0 });
    const out = adaptOperatorShares(base, stats({ crossover: [10, 5] }), 0.8);
    expect(out.get('crossover')).toBe(0);
  });

  it('is not swayed by a single lucky sample as much as by a consistent one', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    const lucky = adaptOperatorShares(base, stats({ mutation: [5, 1], crossover: [0, 10] }), 0.6);
    const consistent = adaptOperatorShares(base, stats({ mutation: [50, 10], crossover: [0, 10] }), 0.6);
    // Same +5.0 average, but ten samples should move the share further than one.
    expect(consistent.get('mutation')!).toBeGreaterThan(lucky.get('mutation')!);
  });
});

describe('adaptivity is clamped and total-preserving', () => {
  it('treats a nonsense adaptivity as off', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    for (const bad of [NaN, -1, undefined as any, 'x' as any]) {
      const out = adaptOperatorShares(base, stats({ mutation: [10, 5], crossover: [-10, 5] }), bad);
      expect(Object.fromEntries(out), `adaptivity=${String(bad)}`).toEqual({ mutation: 0.5, crossover: 0.5 });
    }
  });

  it('an above-range adaptivity behaves like the maximum', () => {
    const base = shares({ mutation: 0.5, crossover: 0.5 });
    const st = stats({ mutation: [10, 5], crossover: [-10, 5] });
    expect(Object.fromEntries(adaptOperatorShares(base, st, 5)))
      .toEqual(Object.fromEntries(adaptOperatorShares(base, st, 1)));
  });
});

/**
 * WIRING, not arithmetic. `adaptOperatorShares` is pure and easy to test; the
 * defect this repo keeps shipping is a correct function nobody calls. These
 * drive the real createNextGeneration and assert the mix actually moved.
 */
describe('adaptivity reaches the real generation transition', () => {
  const parent = (id: string, fitness: number): any => ({
    id, generation: 1, lineageParents: [], status: 'finished', prompt: `prompt ${id}`,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  });

  const cfg = (adaptivity?: number): any => ({
    id: 'c', name: 'adaptive wiring',
    selection: { policy: 'topk', topK: 2 },
    operators: {
      mutationShare: 0.5, crossoverShare: 0.5,
      metaPrompting: { enabled: false, share: 0 },
      paramVariation: { enabled: false, share: 0 },
      modelVariation: { enabled: false, share: 0 },
      ...(adaptivity === undefined ? {} : { adaptivity }),
    },
    population: { initialSize: 8, generationSize: 8, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 4, serviceModelMaxTokens: 100, retries: 1,
  });

  /** Count children produced by each operator, from their changelog labels. */
  async function countByOperator(adaptivity: number | undefined, effectiveness: any) {
    const { createNextGeneration } = await import('../../src/engine/generation.js');
    const parents = [parent('p1', 8), parent('p2', 7)];
    const { newNodes } = await createNextGeneration(
      parents, parents, 1, cfg(adaptivity), [parents], undefined, effectiveness,
    );
    const counts: Record<string, number> = {};
    for (const n of newNodes) {
      const op = (n as any)._operatorType;
      if (op) counts[op] = (counts[op] ?? 0) + 1;
    }
    return counts;
  }

  it('shifts children toward the operator with the better track record', async () => {
    const evidence = { mutation: { totalDelta: 20, count: 5 }, crossover: { totalDelta: -20, count: 5 } };
    const off = await countByOperator(undefined, evidence);
    const on = await countByOperator(0.8, evidence);
    // Equal shares means an even split when adaptivity is off...
    expect(off.mutation).toBe(off.crossover);
    // ...and a shift toward mutation once the evidence is allowed to count.
    expect(on.mutation).toBeGreaterThan(off.mutation);
    expect(on.crossover).toBeLessThan(off.crossover);
  });

  it('does not change the mix when adaptivity is absent from the config', async () => {
    const evidence = { mutation: { totalDelta: 20, count: 5 }, crossover: { totalDelta: -20, count: 5 } };
    const counts = await countByOperator(undefined, evidence);
    expect(counts.mutation).toBe(counts.crossover);
  });

  it('does not change the mix when there is no evidence yet', async () => {
    const counts = await countByOperator(0.8, {});
    expect(counts.mutation).toBe(counts.crossover);
  });
});
