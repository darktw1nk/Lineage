/**
 * Holdout partitioning: tests flagged `holdout: true` are always reserved;
 * `holdoutShare` additionally reserves a seeded-random fraction of the
 * remaining tests. Deterministic for a given (testSet order, share, seed).
 */
import type { TestCase } from '../types.js';
import { mulberry32 } from './rng.js';

export function partitionTestSet(
  testSet: TestCase[],
  holdoutShare: number,
  holdoutSeed: number,
): { fitnessTests: TestCase[]; holdoutTests: TestCase[] } {
  const flagged = testSet.filter(t => t.holdout === true);
  const remaining = testSet.filter(t => t.holdout !== true);

  const share = Math.min(Math.max(holdoutShare || 0, 0), 1);
  const takeCount = Math.floor(remaining.length * share);

  let sharePicked: TestCase[] = [];
  if (takeCount > 0) {
    const rand = mulberry32(holdoutSeed);
    const shuffled = [...remaining];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const pickedIds = new Set(shuffled.slice(0, takeCount).map(t => t.id));
    sharePicked = remaining.filter(t => pickedIds.has(t.id)); // original order
  }

  const holdoutIds = new Set([...flagged, ...sharePicked].map(t => t.id));
  return {
    fitnessTests: testSet.filter(t => !holdoutIds.has(t.id)),
    holdoutTests: testSet.filter(t => holdoutIds.has(t.id)),
  };
}
