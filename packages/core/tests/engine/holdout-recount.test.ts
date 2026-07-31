import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

/**
 * The ungraded recount walked only `generations`. Holdout rows live in
 * `run.holdout.{seed,champion}.perTest` and are graded through the SAME path
 * that sets the flag — so a run whose only ungraded rows were in the holdout
 * reported 0, and the report's warning banner disappeared entirely (it fired
 * before the recount existed). It also ran AFTER persistRun, so the corrected
 * number never reached the database that resume and the desktop read: three
 * numbers in one artefact, and the one the user sees was the wrong one.
 *
 * This pins the arithmetic directly; the ordering is pinned by the recount
 * sitting above `persistRun` in source.
 */
function countUngraded(run: any): number {
  const holdoutLeaves = [run.holdout?.seed, run.holdout?.champion]
    .flatMap((half: any) => (half?.perTest ?? []))
    .filter((row: any) => row?.ungraded).length;
  return run.generations
    .flat()
    .reduce((n: number, node: any) => n + (node.tests ?? []).filter((t: any) => t.ungraded).length, 0)
    + holdoutLeaves;
}

const withHoldout = (seedUngraded: boolean, champUngraded: boolean) => ({
  generations: [[{ tests: [{ testId: 't1', score: 8 }] }]],
  holdout: {
    testIds: ['h1'],
    seed: { score: 0, perTest: [{ testId: 'h1', score: 0, ...(seedUngraded ? { ungraded: true } : {}) }] },
    champion: { score: 0, perTest: [{ testId: 'h1', score: 0, ...(champUngraded ? { ungraded: true } : {}) }] },
  },
});

describe('the ungraded count includes holdout rows', () => {
  it('counts an ungraded row in either holdout half', () => {
    expect(countUngraded(withHoldout(true, true))).toBe(2);
    expect(countUngraded(withHoldout(true, false))).toBe(1);
    expect(countUngraded(withHoldout(false, false))).toBe(0);
  });

  it('counts generation leaves and holdout leaves together', () => {
    const run = withHoldout(true, false) as any;
    run.generations[0][0].tests.push({ testId: 't2', score: 5, ungraded: true });
    expect(countUngraded(run)).toBe(2);
  });

  it('is zero for a run with no holdout at all', () => {
    expect(countUngraded({ generations: [[{ tests: [{ testId: 't1', score: 8 }] }]] })).toBe(0);
  });
});
