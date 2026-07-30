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
  it('scores an ungraded test 0 rather than excluding it', () => {
    // SUPERSEDED ASSERTION. This first demanded exclusion (expecting 2.0), on
    // the reasoning that a placeholder must not be averaged in. Exclusion turned
    // out to be exploitable in the other direction: a candidate that poisons
    // only the tests it FAILS deletes those scores and lifts its own mean —
    // measured, [10,10,1,1] honest = 5.5 against [10,10,ungraded,ungraded] = 10.0
    // on identical answers. 0 is the only value the candidate cannot gain from.
    const q = calculateFitness(
      node([{ score: 2 }, { score: 2 }, { score: 5, ungraded: true }, { score: 5, ungraded: true }]),
      config,
    ).quality;
    expect(q).toBe(1); // (2 + 2 + 0 + 0) / 4
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

/**
 * The chain from "the judge could not be read" to "quality is not credited" has
 * four hops. Both ENDS were tested and the two in the middle were not, so the
 * chain could be broken in the middle with the whole suite green — which is how
 * a run full of fabricated 5.0s reached a user with no warning. Mutation
 * testing confirmed deleting the leaf hop left all 965 tests passing.
 *
 * This pins the hop that now drives quality: evaluatePromptOnTests rebuilds the
 * TestResult from scratch, so it must CARRY `ungraded` up from its samples.
 */
describe('the ungraded flag survives the hop that drives quality', () => {
  // The sample -> TestResult copy is pinned end-to-end by
  // scoring-truth.test.ts ('flags the LEAF'), which drives a real run with an
  // unreadable judge and asserts `ungraded` on the leaf itself.
  it('quality reads the flag off the TestResult, not off a sample', () => {
    // If the leaf loses the flag, this node scores 5 instead of 0 — the exact
    // symptom the whole chain exists to prevent.
    const withFlag = calculateFitness(node([{ score: 5, ungraded: true }]), config).quality;
    const withoutFlag = calculateFitness(node([{ score: 5 }]), config).quality;
    expect(withFlag).toBe(0);
    expect(withoutFlag).toBe(5);
  });
});
