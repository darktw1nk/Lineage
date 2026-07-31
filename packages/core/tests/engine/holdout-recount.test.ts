import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { reconcileUngradedCount } from '../../src/engine/evaluator_v2.js';

/**
 * TAUTOLOGY, REWRITTEN. The first version of this file imported NOTHING from
 * src/ — it pasted a copy of the recount into the test and asserted against the
 * copy. Reverting the entire production fix left all 1173 tests green. Its own
 * docstring claimed the ordering was "pinned by the recount sitting above
 * persistRun in source", i.e. by nothing at all.
 *
 * The real function is now exported and driven directly.
 *
 * What it must do:
 *  - count ungraded leaves in generations AND in both holdout halves
 *  - never LOWER a count the per-call counter already earned, because a node
 *    that failed mid-evaluation has no `tests` array while its siblings may
 *    already have recorded a grading failure
 */
const run = (over: any = {}) => ({
  ungradedTests: 0,
  generations: [[{ tests: [{ testId: 't1', score: 8 }] }]],
  ...over,
} as any);

const holdout = (seedUngraded: boolean, champUngraded: boolean) => ({
  testIds: ['h1'],
  seed: { score: 0, perTest: [{ testId: 'h1', score: 0, ...(seedUngraded ? { ungraded: true } : {}) }] },
  champion: { score: 0, perTest: [{ testId: 'h1', score: 0, ...(champUngraded ? { ungraded: true } : {}) }] },
});

describe('the ungraded count reconciles every source', () => {
  it('counts ungraded rows in either holdout half', () => {
    expect(reconcileUngradedCount(run({ holdout: holdout(true, true) }))).toBe(2);
    expect(reconcileUngradedCount(run({ holdout: holdout(true, false) }))).toBe(1);
    expect(reconcileUngradedCount(run({ holdout: holdout(false, false) }))).toBe(0);
  });

  it('counts generation leaves and holdout leaves together', () => {
    const r = run({ holdout: holdout(true, false) });
    r.generations[0][0].tests.push({ testId: 't2', score: 5, ungraded: true });
    expect(reconcileUngradedCount(r)).toBe(2);
  });

  it('NEVER lowers a count the per-call counter already earned', () => {
    // A node that failed mid-evaluation has no `tests` array, so a leaf sweep
    // finds zero — while a sibling test already recorded a real grading
    // failure. Assigning the sweep result erased it, and after the recount
    // moved above persistRun that erasure was written to the database. Worst
    // case: a run aborted BY the grading circuit breaker reported 0.
    const crashed = run({ ungradedTests: 3, generations: [[{ status: 'failed' }]] });
    expect(reconcileUngradedCount(crashed)).toBe(3);
  });

  it('still raises a count the per-call counter missed', () => {
    // The unknown-distanceMetric branch flags the leaf without incrementing.
    const r = run({ ungradedTests: 0 });
    r.generations[0][0].tests[0].ungraded = true;
    expect(reconcileUngradedCount(r)).toBe(1);
  });
});
