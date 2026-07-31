import type { CandidateNode } from '../types';

/**
 * How much of the run's population was carried forward unchanged.
 *
 * A broken (always-echoing or budget-starved) service model produces honest
 * per-node CARRY/ERROR carries — but a run in which evolution silently did
 * nothing looked identical to a healthy one at every level the desktop shows.
 * The CLI report warns when at least half the children carried; this presenter
 * gives the Footer the same number (pass-20 deferred debt).
 */
export interface CarryShareModel {
  carried: number;
  children: number;
}

export function carryShare(generations: CandidateNode[][] | undefined): CarryShareModel {
  let carried = 0;
  let children = 0;
  (generations ?? []).forEach((gen, g) => (gen ?? []).forEach((node, n) => {
    if (g === 0 && n === 0) return; // the seed baseline is not a child
    const label = node?.changeLog?.[0]?.label;
    children++;
    if (label === 'CARRY' || label === 'ERROR') carried++;
  }));
  return { carried, children };
}

/** True when the Footer should show the warning tile. */
export function carryShareWarns({ carried, children }: CarryShareModel): boolean {
  return children > 0 && carried / children >= 0.5;
}
