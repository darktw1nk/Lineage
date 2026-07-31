import { describe, it, expect } from 'vitest';

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
  generations: [[{ id: 'n1', tests: [{ testId: 't1', score: 8 }] }]],
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

  it('counts a FAILED node that never produced a tests array', () => {
    // A node that fails mid-evaluation has no `tests`, so a pure leaf sweep
    // finds zero while its siblings already recorded real grading failures.
    // The per-node tally is what keeps that visible.
    const crashed = run({ generations: [[{ id: 'n1', status: 'failed' }]] });
    expect(reconcileUngradedCount(crashed, new Map([['n1', 3]]))).toBe(3);
  });

  it('does NOT mix sample counts with test-result counts', () => {
    // The per-call counter increments once per SAMPLE; the sweep counts once
    // per TEST RESULT. Maxing them meant one failure at samplesPerTest 3
    // reported 3, and the report printed '3 test result(s) could not be graded'
    // over exactly one marked row.
    const r = run({ ungradedTests: 3, generations: [[{ id: 'n1', tests: [{ testId: 't1', score: 5, ungraded: true }] }]] });
    expect(reconcileUngradedCount(r, new Map([['n1', 3]]))).toBe(1);
  });

  it('does not double-count a node replayed by a resume', () => {
    // `state.run = { ...run }` carries the counter in from the checkpoint, and
    // the resume re-evaluates replayed nodes — so maxing against it inflated on
    // every restart, compounding. The sweep is per-node and idempotent.
    const r = run({ ungradedTests: 5, generations: [[
      { id: 'n1', tests: [{ testId: 't1', score: 5, ungraded: true }] },
      { id: 'n2', tests: [{ testId: 't1', score: 5, ungraded: true }] },
    ]] });
    expect(reconcileUngradedCount(r, new Map([['n1', 4], ['n2', 4]]))).toBe(2);
  });

  it('still raises a count the per-call counter missed', () => {
    // The unknown-distanceMetric branch flags the leaf without incrementing.
    const r = run({ ungradedTests: 0 });
    r.generations[0][0].tests[0].ungraded = true;
    expect(reconcileUngradedCount(r)).toBe(1);
  });
});
