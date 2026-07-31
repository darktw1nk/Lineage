import { describe, it, expect } from 'vitest';
import { selectChampion } from '@lineage/core';

/**
 * The graph's 🥇 crown must be the champion the tool actually reports.
 *
 * CenterView ranked by raw fitness and filtered out ELITE clones, while the
 * engine uses selectChampion — which includes elites and honours a DECISIVE
 * playoff. So the prompt a user copies off the crowned node could differ from
 * the one in the holdout row, the CLI report and results.json. Elites are
 * playoff contenders and usually the strongest, so the elite case is ordinary,
 * not an edge case.
 */
const n = (id: string, fitness: number, generation = 0) =>
  ({ id, generation, metrics: { fitness } });

describe('the graph crowns the engine champion', () => {
  it('honours a decisive playoff over raw fitness', () => {
    const finished = [n('X', 9), n('Y', 8)];
    const { champion } = selectChampion(
      finished,
      [{ generation: 0, ranking: ['Y', 'X'], decisive: true }],
      c => c.generation,
    );
    // Raw-fitness ranking would crown X; the playoff says Y.
    expect(champion?.id).toBe('Y');
  });

  it('does not exclude an elite clone from the crown', () => {
    const finished = [n('A', 7, 0), n('E1', 9, 1)]; // E1 is an elite clone
    const { champion } = selectChampion(finished, undefined, c => c.generation);
    expect(champion?.id).toBe('E1');
  });

  it('falls back to fitness when no playoff was decisive', () => {
    const finished = [n('X', 9), n('Y', 8)];
    const { champion } = selectChampion(
      finished,
      [{ generation: 0, ranking: ['Y', 'X'], decisive: false }],
      c => c.generation,
    );
    expect(champion?.id).toBe('X');
  });
});
