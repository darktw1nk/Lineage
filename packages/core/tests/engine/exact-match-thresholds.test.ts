import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { evaluateTestResult } from '../../src/engine/fitness.js';

/**
 * Gaps mutation testing found in exact_match grading (hunt 13).
 *
 * distance.test.ts covers the SCORE functions thoroughly, and fitness tests
 * cover llm_grade's `passed` threshold — but nothing asserts what
 * `evaluateTestResult` does with either. Two mutations survive a green suite:
 *
 *   - `passed: score >= 7`  ->  `>= 5` for every distance-graded exact_match test
 *   - `output.trim() === expected.trim()`  ->  `output === expected` under
 *     strictZeroOnDeviation
 *
 * `passed` is not cosmetic: it drives the per-test pass counts in the report and
 * the pass-rate an operator reads to decide whether a prompt works.
 */

describe('distance-graded exact_match passes at 7, not lower', () => {
  const grade = (expected: string, output: string) =>
    evaluateTestResult({ expected }, output, 'exact_match');

  it('a score of 6 is a FAIL', () => {
    // 10 characters, 4 substitutions -> 1 - 0.4 = 0.6 -> 6.
    const r = grade('abcdefghij', 'abcdefXXXX');
    expect(r.score).toBe(6);
    expect(r.passed).toBe(false);
  });

  it('a score of 7 is a PASS', () => {
    // 10 characters, 3 substitutions -> 1 - 0.3 = 0.7 -> 7.
    const r = grade('abcdefghij', 'abcdefgXXX');
    expect(r.score).toBe(7);
    expect(r.passed).toBe(true);
  });
});

describe('strictZeroOnDeviation ignores surrounding whitespace', () => {
  const strict = (expected: string, output: string) =>
    evaluateTestResult({ expected, grading: { strictZeroOnDeviation: true } }, output, 'exact_match');

  it('a trailing newline is not a deviation', () => {
    // Models routinely end a reply with a newline, and chat APIs pad answers
    // with leading space. Comparing untrimmed scores a byte-perfect answer 0 —
    // the harshest grade the mode has — for whitespace nobody can see.
    expect(strict('PARIS', '  PARIS\n')).toEqual({ passed: true, score: 10 });
  });

  it('a real deviation is still 0', () => {
    expect(strict('PARIS', 'LYON')).toEqual({ passed: false, score: 0 });
  });

  it('internal whitespace still counts', () => {
    expect(strict('NEW YORK', 'NEWYORK')).toEqual({ passed: false, score: 0 });
  });
});
