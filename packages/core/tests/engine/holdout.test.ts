import { describe, it, expect } from 'vitest';
import { partitionTestSet } from '../../src/engine/holdout.js';
import type { TestCase } from '../../src/types.js';

const t = (id: string, holdout?: boolean): TestCase =>
  ({ id, name: id, mode: 'exact_match', prompt: 'p', expected: 'e', ...(holdout ? { holdout } : {}) }) as TestCase;

describe('partitionTestSet', () => {
  it('flagged tests are always held out', () => {
    const { fitnessTests, holdoutTests } = partitionTestSet([t('a'), t('b', true), t('c')], 0, 42);
    expect(holdoutTests.map(x => x.id)).toEqual(['b']);
    expect(fitnessTests.map(x => x.id)).toEqual(['a', 'c']);
  });

  it('share splits the remaining tests deterministically', () => {
    const tests = [t('a'), t('b'), t('c'), t('d'), t('e'), t('f'), t('g'), t('h'), t('i'), t('j')];
    const one = partitionTestSet(tests, 0.3, 42);
    const two = partitionTestSet(tests, 0.3, 42);
    expect(one.holdoutTests.map(x => x.id)).toEqual(two.holdoutTests.map(x => x.id)); // same seed → same split
    expect(one.holdoutTests).toHaveLength(3); // floor(10 * 0.3)

    const three = partitionTestSet(tests, 0.3, 7);
    expect(three.holdoutTests.map(x => x.id)).not.toEqual(one.holdoutTests.map(x => x.id)); // different seed → different split
  });

  it('flags and share compose (share applies to the non-flagged remainder)', () => {
    const tests = [t('a', true), t('b'), t('c'), t('d'), t('e')]; // 1 flagged + 4 remaining
    const { fitnessTests, holdoutTests } = partitionTestSet(tests, 0.5, 42);
    expect(holdoutTests.some(x => x.id === 'a')).toBe(true);
    expect(holdoutTests).toHaveLength(1 + 2); // flagged + floor(4 * 0.5)
    expect(fitnessTests).toHaveLength(2);
  });

  it('share 0 and no flags → everything is fitness', () => {
    const { fitnessTests, holdoutTests } = partitionTestSet([t('a'), t('b')], 0, 42);
    expect(fitnessTests).toHaveLength(2);
    expect(holdoutTests).toHaveLength(0);
  });

  it('preserves original test order within each partition', () => {
    const tests = [t('a'), t('b', true), t('c'), t('d')];
    const { fitnessTests } = partitionTestSet(tests, 0, 42);
    expect(fitnessTests.map(x => x.id)).toEqual(['a', 'c', 'd']);
  });
});
