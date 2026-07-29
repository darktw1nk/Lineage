import { describe, it, expect } from 'vitest';
import { selectChampion } from '../../src/engine/champion.js';
import type { CandidateNode } from '../../src/types.js';

function node(id: string, fitness: number, generation = 0): CandidateNode {
  return {
    id, generation, lineageParents: [], status: 'finished', prompt: `P-${id}`,
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [], metrics: { fitness, quality: fitness },
    tests: [{ testId: 't1', passed: true, score: fitness, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
  } as any;
}

const genOf = (n: CandidateNode) => n.generation;

describe('a non-decisive playoff must not pick the champion', () => {
  // maybeRunPlayoff withholds playoffRank when the top two are separated by
  // less than a full point, and logs that "selection stays fitness-based" —
  // but it recorded the ranking anyway, and selectChampion took ranking[0]
  // from it regardless. So the champion the user takes away, and the prompt
  // the holdout measures, came from a ranking the run had explicitly
  // discarded. Measured: a report claiming "Champion selected by pairwise
  // playoff / Fitness 5.000" three lines under "Best Fitness 10.000".
  const nodes = [node('weak', 5), node('strong', 10), node('worst', 1)];

  it('falls back to fitness when the playoff was not decisive', () => {
    const { champion } = selectChampion(
      nodes,
      [{ generation: 0, ranking: ['weak', 'strong', 'worst'], decisive: false }],
      genOf,
    );
    expect(champion!.id).toBe('strong');
  });

  it('still honours a DECISIVE playoff over raw fitness', () => {
    // The feature has to keep working — that is the whole point of pairwise.
    const { champion } = selectChampion(
      nodes,
      [{ generation: 0, ranking: ['weak', 'strong', 'worst'], decisive: true }],
      genOf,
    );
    expect(champion!.id).toBe('weak');
  });

  it('treats a checkpoint written before the flag as decisive', () => {
    // Those runs really did act on the ranking; honouring it keeps them
    // reproducible rather than silently re-deciding their champion.
    const { champion } = selectChampion(
      nodes,
      [{ generation: 0, ranking: ['weak', 'strong', 'worst'] }],
      genOf,
    );
    expect(champion!.id).toBe('weak');
  });

  it('ignores a non-decisive playoff without claiming the playoff was stale', () => {
    // `staleplayoffIgnored` drives a different warning ("the playoff predates
    // the newest generation"), which would be the wrong explanation here.
    const { staleplayoffIgnored } = selectChampion(
      nodes,
      [{ generation: 0, ranking: ['weak', 'strong', 'worst'], decisive: false }],
      genOf,
    );
    expect(staleplayoffIgnored).toBe(false);
  });
});
