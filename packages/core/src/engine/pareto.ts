/**
 * Which candidates were NOT dominated by any other candidate in the run.
 *
 * Fitness here is a weighted sum, and a weighted sum provably cannot select
 * points in a concave region of the trade-off surface — no weighting reaches
 * them. Replacing selection with a Pareto scheme (NSGA-II and friends) would
 * be a different product: it returns a set of incomparable answers rather than
 * one champion, and on 6–24 candidates per generation the "front" is mostly
 * noise anyway.
 *
 * So this reports rather than selects. After a run it names the candidates
 * nothing else beat outright, which turns the theoretical limitation into a
 * visible one: if the champion is alone on the front, the scalarization cost
 * you nothing; if it isn't, you can see exactly what your weights traded away.
 */
import type { CandidateNode } from '../types.js';

/**
 * Direction of each fitness dimension. Getting this backwards would report the
 * WORST candidates as the interesting ones, so it is stated explicitly rather
 * than inferred.
 */
const HIGHER_IS_BETTER = ['quality', 'safety', 'stability'] as const;
const LOWER_IS_BETTER = ['costUSD', 'latencyMs'] as const;

type Scored = Pick<CandidateNode, 'id'> & { metrics?: CandidateNode['metrics'] };

/** Dimensions both candidates actually measured — an absent metric is unknown, not zero. */
function sharedDimensions(a: Scored, b: Scored): Array<{ key: string; higherBetter: boolean }> {
  const dims: Array<{ key: string; higherBetter: boolean }> = [];
  for (const key of HIGHER_IS_BETTER) {
    if (typeof (a.metrics as any)?.[key] === 'number' && typeof (b.metrics as any)?.[key] === 'number') {
      dims.push({ key, higherBetter: true });
    }
  }
  for (const key of LOWER_IS_BETTER) {
    if (typeof (a.metrics as any)?.[key] === 'number' && typeof (b.metrics as any)?.[key] === 'number') {
      dims.push({ key, higherBetter: false });
    }
  }
  return dims;
}

/** Does `a` dominate `b`: at least as good everywhere they can be compared, and strictly better somewhere. */
function dominates(a: Scored, b: Scored): boolean {
  const dims = sharedDimensions(a, b);
  if (dims.length === 0) return false;
  let strictlyBetterSomewhere = false;
  for (const { key, higherBetter } of dims) {
    const av = (a.metrics as any)[key] as number;
    const bv = (b.metrics as any)[key] as number;
    const aBetter = higherBetter ? av > bv : av < bv;
    const aWorse = higherBetter ? av < bv : av > bv;
    if (aWorse) return false;
    if (aBetter) strictlyBetterSomewhere = true;
  }
  return strictlyBetterSomewhere;
}

/**
 * The non-dominated set, in input order.
 *
 * Candidates with no metrics are skipped rather than treated as zero — an
 * unscored node is not a fast, free, perfect one.
 */
export function paretoFront<T extends Scored>(candidates: readonly T[]): T[] {
  const scored = candidates.filter(c => c.metrics && Object.keys(c.metrics).length > 0);
  return scored.filter(c => !scored.some(other => other !== c && dominates(other, c)));
}
