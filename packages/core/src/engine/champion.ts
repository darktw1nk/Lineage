/**
 * One rule for "which candidate is the answer", shared by the engine's holdout
 * pass and the CLI's results.json, so the two can never disagree about it.
 */
import type { CandidateNode, UUID } from '../types.js';

export interface ChampionChoice<T> {
  champion: T | undefined;
  /** True when a playoff result existed but did not cover the newest evaluated generation. */
  staleplayoffIgnored: boolean;
}

/**
 * Pick the champion from finished nodes.
 *
 * A playoff winner is honoured ONLY when its playoff covers the newest
 * generation that produced finished nodes. Taking the most recent playoff
 * unconditionally was wrong whenever the final generation's playoff was skipped
 * (budget exhausted, fewer than two finished contenders, no llm_grade tests):
 * `best` silently reverted to an earlier generation's winner and discarded
 * strictly better, fully-evaluated candidates — while the report still claimed
 * "champion selected by pairwise playoff".
 */
export function selectChampion<T extends { id: UUID; generation?: number; metrics?: CandidateNode['metrics'] }>(
  finished: readonly T[],
  playoffs: ReadonlyArray<{ generation: number; ranking: UUID[] }> | undefined,
  generationOf: (node: T) => number,
): ChampionChoice<T> {
  const byFitness = [...finished].sort((a, b) => (b.metrics?.fitness ?? -Infinity) - (a.metrics?.fitness ?? -Infinity));
  const bestByFitness = byFitness[0];

  const latestPlayoff = [...(playoffs ?? [])].sort((a, b) => b.generation - a.generation)[0];
  if (!latestPlayoff) return { champion: bestByFitness, staleplayoffIgnored: false };

  const newestEvaluatedGeneration = finished.reduce(
    (max, node) => Math.max(max, generationOf(node)),
    -Infinity,
  );
  if (latestPlayoff.generation !== newestEvaluatedGeneration) {
    return { champion: bestByFitness, staleplayoffIgnored: true };
  }

  const winner = finished.find(n => n.id === latestPlayoff.ranking[0]);
  return { champion: winner ?? bestByFitness, staleplayoffIgnored: !winner };
}
