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

import { stagnationRestartCount } from '../../src/engine/generation.js';

/**
 * Stagnation restart.
 *
 * Elitism guarantees the best fitness never regresses, which also means a run
 * that has converged on a local optimum looks exactly like a run that is
 * finished: the same number goes on the board every generation while every
 * child costs full price. Diversity in selection delays that; it does not
 * escape it, because once the whole population descends from one prompt there
 * is nothing diverse left to select.
 *
 * `restartAfter: N` re-seeds a fraction of the next generation from the
 * ORIGINAL seed prompt when the best fitness has not improved for N
 * generations — the standard catastrophe/immigrant mechanism.
 *
 * Rules:
 *  - OFF by default. A run that improves every generation never triggers it.
 *  - The champion is untouched: elitism still carries it, so a restart can
 *    only cost exploration budget, never the best answer found.
 *  - It fires on a PLATEAU, not on a dip — fitness cannot dip under elitism,
 *    so "no improvement" is the only signal available.
 *  - A tiny improvement still counts as improvement (no epsilon games that
 *    would make the trigger fire on a genuinely progressing run).
 */
const history = (...best: number[]) => best;

describe('restart is off unless configured', () => {
  it('never restarts when restartAfter is undefined', () => {
    expect(stagnationRestartCount(history(5, 5, 5, 5, 5), undefined, 6)).toBe(0);
  });

  it('never restarts when restartAfter is 0', () => {
    expect(stagnationRestartCount(history(5, 5, 5, 5, 5), 0, 6)).toBe(0);
  });
});

describe('restart fires only on a genuine plateau', () => {
  it('does not fire while fitness is still improving', () => {
    expect(stagnationRestartCount(history(3, 5, 7, 9), 2, 6)).toBe(0);
  });

  it('does not fire before the plateau is long enough', () => {
    // Two generations at 7.0 with restartAfter 3 is not yet stagnation.
    expect(stagnationRestartCount(history(3, 7, 7), 3, 6)).toBe(0);
  });

  it('fires once the plateau reaches the configured length', () => {
    // restartAfter 3 means THREE generations with no improvement after the
    // last one: improved at index 1, then flat at 2, 3 and 4.
    expect(stagnationRestartCount(history(3, 7, 7, 7), 3, 6)).toBe(0);
    expect(stagnationRestartCount(history(3, 7, 7, 7, 7), 3, 6)).toBeGreaterThan(0);
  });

  it('treats even a small improvement as improvement', () => {
    // 7.00 -> 7.01 is progress; a run creeping upward must not be restarted.
    expect(stagnationRestartCount(history(7, 7, 7.01), 2, 6)).toBe(0);
  });

  it('measures the plateau from the last improvement, not the start', () => {
    // Improved at generation 3, then flat for 2 — with restartAfter 3 that is
    // not yet a long enough plateau.
    expect(stagnationRestartCount(history(5, 5, 5, 9, 9), 3, 6)).toBe(0);
  });
});

describe('a restart replaces some of the population, never all of it', () => {
  it('leaves the majority of the generation to normal breeding', () => {
    const n = stagnationRestartCount(history(7, 7, 7, 7, 7), 3, 10);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it('scales with generation size', () => {
    const small = stagnationRestartCount(history(7, 7, 7, 7, 7), 3, 4);
    const large = stagnationRestartCount(history(7, 7, 7, 7, 7), 3, 20);
    expect(large).toBeGreaterThan(small);
  });

  it('always injects at least one immigrant when it fires at all', () => {
    expect(stagnationRestartCount(history(7, 7, 7, 7, 7), 3, 2)).toBeGreaterThanOrEqual(1);
  });

  it('cannot ask for more immigrants than the generation holds', () => {
    expect(stagnationRestartCount(history(7, 7, 7, 7, 7), 3, 1)).toBeLessThanOrEqual(1);
  });
});

describe('it survives nonsense input rather than misbehaving', () => {
  it('does nothing with too little history to judge', () => {
    expect(stagnationRestartCount(history(), 2, 6)).toBe(0);
    expect(stagnationRestartCount(history(5), 2, 6)).toBe(0);
  });

  it('ignores a non-finite restartAfter', () => {
    for (const bad of [NaN, -3, undefined as any, 'x' as any]) {
      expect(stagnationRestartCount(history(7, 7, 7, 7, 7), bad, 6), `restartAfter=${String(bad)}`).toBe(0);
    }
  });
});

/**
 * WIRING. The pure function above is easy; the failure mode this repo keeps
 * shipping is a correct function nobody calls. These drive the real
 * createNextGeneration with a stagnant history and assert immigrants appear.
 */
describe('a stagnant run actually gets immigrants from the real transition', () => {
  const node = (id: string, prompt: string, fitness: number): any => ({
    id, generation: 0, lineageParents: [], status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  });

  const cfg = (restartAfter?: number): any => ({
    id: 'c', name: 'restart wiring',
    selection: { policy: 'topk', topK: 2, ...(restartAfter === undefined ? {} : { restartAfter }) },
    operators: {
      mutationShare: 1, crossoverShare: 0,
      metaPrompting: { enabled: false, share: 0 },
      paramVariation: { enabled: false, share: 0 },
      modelVariation: { enabled: false, share: 0 },
    },
    population: { initialSize: 8, generationSize: 8, seedPrompt: 'THE ORIGINAL SEED PROMPT', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 4, serviceModelMaxTokens: 100, retries: 1,
  });

  /** Four generations all peaking at 7.0 — a textbook plateau. */
  const stagnantHistory = () => {
    const gen = (n: number) => [node(`a${n}`, `converged prompt ${n}`, 7), node(`b${n}`, `converged prompt ${n}b`, 6)];
    return [gen(0), gen(1), gen(2), gen(3)];
  };

  async function immigrantsIn(restartAfter?: number) {
    const { createNextGeneration } = await import('../../src/engine/generation.js');
    const all = stagnantHistory();
    const parents = all[all.length - 1];
    const { newNodes } = await createNextGeneration(parents, parents, 4, cfg(restartAfter), all);
    return newNodes.filter(n => n.changeLog?.[0]?.text?.includes('Restart:'));
  }

  it('injects immigrants carrying the ORIGINAL seed prompt', async () => {
    const immigrants = await immigrantsIn(3);
    expect(immigrants.length).toBeGreaterThan(0);
    expect(immigrants.every(n => n.prompt === 'THE ORIGINAL SEED PROMPT')).toBe(true);
  });

  it('injects nothing when restartAfter is not configured', async () => {
    expect(await immigrantsIn(undefined)).toHaveLength(0);
  });

  it('still fills the generation to the configured size', async () => {
    const { createNextGeneration } = await import('../../src/engine/generation.js');
    const all = stagnantHistory();
    const parents = all[all.length - 1];
    const { newNodes } = await createNextGeneration(parents, parents, 4, cfg(3), all);
    expect(newNodes).toHaveLength(8);
  });

  it('leaves the immigrants unattributed, so no operator is credited for them', async () => {
    const immigrants = await immigrantsIn(3);
    expect(immigrants.every(n => (n as any)._operatorType === null)).toBe(true);
  });
});
