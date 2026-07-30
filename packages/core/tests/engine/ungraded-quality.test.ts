import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { calculateFitness, resetFitnessWarnings } from '../../src/engine/fitness.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * An ungraded test's 5.0 is a PLACEHOLDER, not a measurement, and averaging it
 * into quality is the free-10 bug class again — the same one that already hit
 * `stability` (undefined became 10, so a run scoring 1/10 reported fitness 8.2
 * and stopped with reason "target") and `safety`. The established rule in this
 * codebase is that a dimension which cannot be measured is DISABLED, never
 * defaulted to a neutral-looking number.
 *
 * It is also directly exploitable. The echo defence discards any `"score"`
 * token the candidate itself emitted; a candidate that emits one for every
 * value 0..10 makes every possible verdict look echoed, so nothing is trusted,
 * the test is ungraded, and it collects 5.0 — which for a genuinely bad answer
 * is a large unearned gain, authored by the candidate. Evolution finds and
 * keeps exactly this.
 */
function node(tests: Array<{ score: number; ungraded?: boolean }>): CandidateNode {
  return {
    id: 'n', generation: 0, lineageParents: [], status: 'finished', prompt: 'p',
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [],
    tests: tests.map((t, i) => ({
      testId: `t${i}`, passed: t.score >= 7, score: t.score,
      promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o',
      ...(t.ungraded ? { ungraded: true } : {}),
    })),
    metrics: { quality: 0, fitness: 0, costUSD: 0, latencyMs: 1 },
  } as any;
}

const config = {
  id: 'c', name: 'c', fitness: { weights: { quality: 1 } },
  selection: {}, operators: {}, population: {}, targets: {},
  enabledModels: [], serviceModel: { provider: 'x', model: 'y' },
  testSet: [], parallelLimit: 1,
} as unknown as EvaluationConfig;

beforeEach(() => resetFitnessWarnings());

describe('a fabricated 5.0 does not count as quality', () => {
  it('excludes ungraded tests from the average', () => {
    // Two real 2s and two placeholders. Averaging the placeholders in yields
    // 3.5; the truth on what could actually be measured is 2.0.
    const q = calculateFitness(
      node([{ score: 2 }, { score: 2 }, { score: 5, ungraded: true }, { score: 5, ungraded: true }]),
      config,
    ).quality;
    expect(q).toBe(2);
  });

  it('gives a candidate nothing for forcing every test ungraded', () => {
    // The exploit: emit a "score" token for every value 0..10 so the echo
    // defence discards them all. Previously this floored the candidate at 5.0.
    const q = calculateFitness(
      node([{ score: 5, ungraded: true }, { score: 5, ungraded: true }]),
      config,
    ).quality;
    expect(q).toBe(0);
  });

  it('a genuinely bad candidate cannot improve by becoming unmeasurable', () => {
    const honest = calculateFitness(node([{ score: 2 }, { score: 2 }]), config).quality;
    const gaming = calculateFitness(
      node([{ score: 5, ungraded: true }, { score: 5, ungraded: true }]), config,
    ).quality;
    expect(gaming).toBeLessThanOrEqual(honest);
  });

  it('leaves an ordinary fully-graded candidate untouched', () => {
    expect(calculateFitness(node([{ score: 8 }, { score: 6 }]), config).quality).toBe(7);
  });

  it('still scores a measured 5 as a real 5', () => {
    expect(calculateFitness(node([{ score: 5 }, { score: 5 }]), config).quality).toBe(5);
  });
});
