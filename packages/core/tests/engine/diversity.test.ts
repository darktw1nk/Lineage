import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai', estimateTokens: () => ({ prompt: 1 }),
    call: async () => ({ output: 'stub', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
  }),
}));

import { selectTopPerformers } from '../../src/engine/generation.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * Diversity maintenance.
 *
 * Truncation selection (Top-K/Top-P) plus elitism is strongly exploitative: it
 * ranks by fitness alone, so once one lineage pulls ahead it takes every parent
 * slot and the population converges on near-copies of a single prompt. Every
 * later generation then pays full price to re-measure variations of the same
 * text — the search stops searching while the run still reports progress.
 *
 * `selection.diversity` (0..1) trades some of that exploitation for coverage:
 * parents are chosen greedily by fitness DISCOUNTED by similarity to the
 * parents already chosen, so a slightly worse but genuinely different prompt
 * can take a slot from a near-duplicate. 0 (default) is exactly the old
 * behaviour, byte for byte.
 */
function node(id: string, prompt: string, fitness: number): CandidateNode {
  return {
    id, generation: 1, lineageParents: [], status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  } as CandidateNode;
}

function config(over: any = {}): EvaluationConfig {
  return {
    id: 'c1', name: 'diversity',
    selection: { policy: 'topk', topK: 3, ...over },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 6, generationSize: 6, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  } as EvaluationConfig;
}

// Three near-identical high scorers and one genuinely different candidate.
// This is what a converging population looks like.
const CLONE_A = node('a', 'Summarize the ticket. Be concise and accurate.', 8.0);
const CLONE_B = node('b', 'Summarize the ticket. Be concise and accurate!', 7.9);
const CLONE_C = node('c', 'Summarize the ticket. Be concise, and accurate.', 7.8);
const DIFFERENT = node('d', 'Extract order=<id> | issue=<text> | request=<text> from the ticket.', 7.0);

beforeEach(() => vi.clearAllMocks());

describe('diversity is OFF by default — existing runs are untouched', () => {
  it('picks the top K by fitness alone when diversity is unset', () => {
    const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config());
    expect(picked.map(n => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('picks the top K by fitness alone when diversity is explicitly 0', () => {
    const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 0 }));
    expect(picked.map(n => n.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('diversity > 0 spends a slot on a different prompt', () => {
  it('drops the third near-duplicate in favour of the distinct candidate', () => {
    const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 0.5 }));
    // The best candidate is always kept — diversity never costs you the champion.
    expect(picked[0].id).toBe('a');
    expect(picked.map(n => n.id)).toContain('d');
    expect(picked).toHaveLength(3);
  });

  it('keeps the strongest candidate first even at maximum diversity', () => {
    const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 1 }));
    expect(picked[0].id).toBe('a');
  });

  it('changes nothing when every candidate is already distinct', () => {
    const distinct = [
      node('p', 'Alpha instructions for the model to follow closely', 9),
      node('q', 'Bravo guidance about formatting numbers as digits', 8),
      node('r', 'Charlie rules concerning tone and voice of replies', 7),
      node('s', 'Delta notes regarding refusal and safety handling', 6),
    ];
    const plain = selectTopPerformers(distinct, config());
    const diverse = selectTopPerformers(distinct, config({ diversity: 0.5 }));
    expect(diverse.map(n => n.id)).toEqual(plain.map(n => n.id));
  });

  it('never returns fewer parents than plain selection would', () => {
    const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 0.8 }));
    expect(picked).toHaveLength(3);
  });
});

describe('diversity respects the rest of the selection contract', () => {
  it('still honours a playoff ranking for the top pick', () => {
    const ranked = { ...CLONE_C, metrics: { ...CLONE_C.metrics, playoffRank: 1 } } as CandidateNode;
    const picked = selectTopPerformers([CLONE_A, CLONE_B, ranked, DIFFERENT], config({ diversity: 0.5 }));
    expect(picked[0].id).toBe('c');
  });

  it('works with Top-P as well as Top-K', () => {
    const picked = selectTopPerformers(
      [CLONE_A, CLONE_B, CLONE_C, DIFFERENT],
      config({ policy: 'topp', topP: 0.7, diversity: 0.5 }),
    );
    expect(picked.length).toBeGreaterThan(0);
    expect(picked[0].id).toBe('a');
  });

  it('ignores unfinished and unscored candidates, as before', () => {
    const unscored = { ...DIFFERENT, id: 'x', metrics: undefined } as unknown as CandidateNode;
    const unfinished = { ...DIFFERENT, id: 'y', status: 'running' } as CandidateNode;
    const picked = selectTopPerformers(
      [CLONE_A, unscored, unfinished, DIFFERENT], config({ diversity: 0.5 }),
    );
    expect(picked.map(n => n.id).sort()).toEqual(['a', 'd']);
  });

  it('treats a non-finite or negative diversity as OFF', () => {
    // These are the values that must not silently change selection. NaN in
    // particular: `NaN > 0` is false, so an unclamped implementation skips
    // diversity entirely — same outcome, but by accident rather than by rule.
    for (const bad of [-1, NaN, undefined as any, 'x' as any]) {
      const picked = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: bad }));
      expect(picked.map(n => n.id), `diversity=${String(bad)}`).toEqual(['a', 'b', 'c']);
    }
  });

  it('an above-range diversity behaves like the maximum, not like something else', () => {
    // NOTE, verified by mutation: removing the upper clamp is an EQUIVALENT
    // mutant. The discount (1 - d × similarity) is monotonic in d, so an
    // over-large value pushes similar candidates further down but never
    // reorders them relative to each other — it cannot invert the ranking.
    // The clamp is kept for defined behaviour, not because it changes a pick,
    // and this test pins the observable contract rather than pretending to
    // catch something it cannot.
    const over = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 5 }));
    const atMax = selectTopPerformers([CLONE_A, CLONE_B, CLONE_C, DIFFERENT], config({ diversity: 1 }));
    expect(over.map(n => n.id)).toEqual(atMax.map(n => n.id));
  });
});
