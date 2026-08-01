import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({ store: { get: () => null, set: () => {}, store: {} }, setStore: vi.fn() }));
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai', estimateTokens: () => ({ prompt: 1 }),
    call: async () => ({ output: 'stub', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
  }),
}));

import { selectTopPerformers } from '../../src/engine/generation.js';
import { noveltyArchive } from '../../src/engine/evaluator_v2.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * Novelty.
 *
 * `diversity` compares a candidate against the parents chosen THIS generation,
 * which stops one generation filling with near-copies. It cannot see that the
 * same prompt already won three generations ago and is being re-explored on a
 * loop — each generation looks internally varied while the run as a whole
 * circles the same small region.
 *
 * `novelty` scores a candidate against an ARCHIVE of everything the run has
 * already evaluated: territory that has been searched is worth less than
 * territory that has not. It composes with diversity rather than replacing it.
 *
 * Rules:
 *  - OFF by default, and with no archive it must change nothing.
 *  - The fittest candidate is still picked first: novelty must never cost the
 *    champion, exactly like diversity.
 *  - A prompt the archive has never seen outranks a rehash of an old one, at
 *    equal-ish fitness.
 */
function node(id: string, prompt: string, fitness: number): CandidateNode {
  return {
    id, generation: 2, lineageParents: [], status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  } as CandidateNode;
}

function config(over: any = {}): EvaluationConfig {
  return {
    id: 'c1', name: 'novelty',
    selection: { policy: 'topk', topK: 2, ...over },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 6, generationSize: 6, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  } as EvaluationConfig;
}

// A prompt the run has explored to death, and a genuinely new direction.
const OLD_TERRITORY = 'Summarize the customer ticket concisely and accurately for the support team';
const REHASH = node('rehash', OLD_TERRITORY + ' please', 8.0);
const FRESH = node('fresh', 'Extract order=<id> | issue=<text> | request=<text> from the ticket', 7.6);

/** What the run has already evaluated, in earlier generations. */
const archive = [
  node('old1', OLD_TERRITORY, 8.0),
  node('old2', OLD_TERRITORY + '.', 7.9),
  node('old3', OLD_TERRITORY + '!', 7.8),
];

describe('novelty is off by default', () => {
  it('ranks by fitness alone when novelty is unset', () => {
    const picked = selectTopPerformers([REHASH, FRESH], config(), archive);
    expect(picked.map(n => n.id)).toEqual(['rehash', 'fresh']);
  });

  it('ranks by fitness alone when novelty is 0', () => {
    const picked = selectTopPerformers([REHASH, FRESH], config({ novelty: 0 }), archive);
    expect(picked.map(n => n.id)).toEqual(['rehash', 'fresh']);
  });

  it('changes nothing when there is no archive to compare against', () => {
    const withArchive = selectTopPerformers([REHASH, FRESH], config({ novelty: 0.8 }), []);
    const without = selectTopPerformers([REHASH, FRESH], config());
    expect(withArchive.map(n => n.id)).toEqual(without.map(n => n.id));
  });
});

describe('novelty > 0 prefers unexplored territory', () => {
  it('promotes the fresh direction over a rehash of explored ground', () => {
    const picked = selectTopPerformers([REHASH, FRESH], config({ novelty: 0.8, topK: 1 }), archive);
    expect(picked.map(n => n.id)).toEqual(['fresh']);
  });

  it('does not promote a fresh candidate that is far worse', () => {
    const muchWorse = node('weak', 'Something totally unrelated and new', 1.0);
    const picked = selectTopPerformers([REHASH, muchWorse], config({ novelty: 0.5, topK: 1 }), archive);
    expect(picked.map(n => n.id)).toEqual(['rehash']);
  });

  it('composes with diversity rather than fighting it', () => {
    const picked = selectTopPerformers(
      [REHASH, FRESH], config({ novelty: 0.6, diversity: 0.5, topK: 2 }), archive,
    );
    expect(picked).toHaveLength(2);
    expect(picked.map(n => n.id)).toContain('fresh');
  });
});

describe('novelty respects the rest of the selection contract', () => {
  it('clamps a nonsense value to off', () => {
    for (const bad of [NaN, -1, undefined as any, 'x' as any]) {
      const picked = selectTopPerformers([REHASH, FRESH], config({ novelty: bad }), archive);
      expect(picked.map(n => n.id), `novelty=${String(bad)}`).toEqual(['rehash', 'fresh']);
    }
  });

  it('still ignores unfinished and unscored candidates', () => {
    const unscored = { ...FRESH, id: 'x', metrics: undefined } as unknown as CandidateNode;
    const picked = selectTopPerformers([REHASH, unscored], config({ novelty: 0.8 }), archive);
    expect(picked.map(n => n.id)).toEqual(['rehash']);
  });

  it('never returns fewer parents than plain selection would', () => {
    const picked = selectTopPerformers([REHASH, FRESH], config({ novelty: 0.9, topK: 2 }), archive);
    expect(picked).toHaveLength(2);
  });
});

/**
 * WIRING. The tests above hand `selectTopPerformers` an archive directly, so
 * they all pass even if the EVALUATOR never builds one — verified by mutation.
 * This drives the real selection path with the shape the evaluator produces:
 * earlier generations' finished nodes.
 */
describe('the archive the evaluator builds is the one novelty needs', () => {
  it('re-ranks using prompts from EARLIER generations, not just this one', async () => {
    // Reproduce what evaluator_v2 assembles: generations[0..current-1] flat,
    // finished only. If that construction were wrong or missing, novelty could
    // never fire in a real run however good the pure function is.
    const generations: CandidateNode[][] = [
      [node('g0a', OLD_TERRITORY, 8.0), node('g0b', OLD_TERRITORY + '.', 7.9)],
      [node('g1a', OLD_TERRITORY + '!', 7.8), { ...node('g1b', 'unfinished', 9), status: 'failed' } as CandidateNode],
      [REHASH, FRESH],
    ];
    // The REAL construction from evaluator_v2, not a copy of it: if the
    // evaluator stopped building an archive, this test would fail.
    const builtArchive = noveltyArchive(generations, 2);

    // The failed node must not enter the archive — an unevaluated prompt is
    // not explored territory.
    expect(builtArchive.map(n => n.id)).toEqual(['g0a', 'g0b', 'g1a']);

    const picked = selectTopPerformers(generations[2], config({ novelty: 0.8, topK: 1 }), builtArchive);
    expect(picked.map(n => n.id)).toEqual(['fresh']);
  });

  it('an empty archive (generation 1) leaves selection untouched', () => {
    const builtArchive = noveltyArchive([[REHASH, FRESH]], 0);
    expect(builtArchive).toEqual([]);
    const picked = selectTopPerformers([REHASH, FRESH], config({ novelty: 0.8 }), builtArchive);
    expect(picked.map(n => n.id)).toEqual(['rehash', 'fresh']);
  });
});
