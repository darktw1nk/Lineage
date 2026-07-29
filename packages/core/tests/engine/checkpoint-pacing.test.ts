import { describe, it, expect } from 'vitest';
import { nodeCheckpointDue } from '../../src/engine/evaluator_v2.js';

/**
 * persistRun does JSON.stringify(state.run) plus an UPDATE carrying that whole
 * string, and state.run holds every node of every generation with every test
 * output. Running it once per node is therefore O(nodes x runSize) — quadratic.
 * Measured on a 30-node x 20-generation run with 20 KB outputs: generation 19
 * took 33.9s of which 92% was checkpointing, against 1.5s for generation 0.
 *
 * The fix paces checkpoints against their own measured cost, so checkpointing
 * can never consume more than 1/20th of wall-clock time.
 */
describe('per-node checkpoint pacing', () => {
  it('always checkpoints the first node', () => {
    expect(nodeCheckpointDue(1000, 0, 0)).toBe(true);
  });

  it('does not throttle cheap checkpoints', () => {
    // A 2ms checkpoint needs only 40ms of elapsed time. Real nodes take far
    // longer than that, so small runs still checkpoint on every node.
    expect(nodeCheckpointDue(1_000_040, 1_000_000, 2)).toBe(true);
  });

  it('backs off in proportion to what a checkpoint costs', () => {
    // A 500ms checkpoint must not run again for 10s.
    expect(nodeCheckpointDue(1_005_000, 1_000_000, 500)).toBe(false);
    expect(nodeCheckpointDue(1_010_000, 1_000_000, 500)).toBe(true);
  });

  it('caps the gap so a huge run still checkpoints regularly', () => {
    // Without a ceiling, a 5s checkpoint would imply a 100s gap — far more
    // work at risk than a crash should ever cost.
    expect(nodeCheckpointDue(1_015_000, 1_000_000, 5_000)).toBe(true);
  });

  it('keeps the checkpoint duty cycle at or below 5%', () => {
    // The property that makes the total cost linear rather than quadratic.
    for (const costMs of [1, 10, 100, 400, 750]) {
      const gapAtWhichItFires = costMs * 20;
      expect(nodeCheckpointDue(gapAtWhichItFires - 1, 0, costMs)).toBe(false);
      expect(nodeCheckpointDue(gapAtWhichItFires, 0, costMs)).toBe(true);
      expect(costMs / gapAtWhichItFires).toBeLessThanOrEqual(0.05);
    }
  });
});
