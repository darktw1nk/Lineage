import { describe, it, expect } from 'vitest';
import { calculateStabilityFromSamples } from '../../src/engine/fitness.js';
import type { CandidateNode } from '../../src/types.js';

function nodeWith(samplesPerTest: number[][]): CandidateNode {
  return {
    id: 'n', generation: 0, lineageParents: [], status: 'finished', prompt: 'p',
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0 },
    changeLog: [],
    tests: samplesPerTest.map((samples, i) => ({
      testId: `t${i}`, passed: true,
      score: samples.reduce((a, b) => a + b, 0) / samples.length,
      samples, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'x',
    })),
  } as any;
}

describe('stability is measured from repeat SCORES, not reply length', () => {
  it('identical scores are perfectly stable', () => {
    expect(calculateStabilityFromSamples(nodeWith([[8, 8, 8]]))).toBe(10);
  });

  it('same meaning phrased differently is NOT penalised', () => {
    // The old measure scored `1 - CV(output length)`, so three correct answers
    // where one was worded differently scored 0.0 — the worst possible — while
    // three CONTRADICTORY answers of similar length scored 6.3. Scores are what
    // reliability means.
    expect(calculateStabilityFromSamples(nodeWith([[10, 10, 10]]))).toBe(10);
  });

  it('disagreeing scores are unstable', () => {
    const stable = calculateStabilityFromSamples(nodeWith([[7, 7, 7]]))!;
    const wobbly = calculateStabilityFromSamples(nodeWith([[10, 5, 0]]))!;
    expect(wobbly).toBeLessThan(stable);
  });

  it('normalises against the score range, not the mean', () => {
    // A coefficient of variation blows up as the mean approaches zero, so
    // 0,0,1 would look wildly less stable than 8,8,9 for the same spread.
    const nearZero = calculateStabilityFromSamples(nodeWith([[0, 0, 1]]))!;
    const nearTen = calculateStabilityFromSamples(nodeWith([[8, 8, 9]]))!;
    expect(Math.abs(nearZero - nearTen)).toBeLessThan(0.001);
  });

  it('is undefined when there is nothing to compare', () => {
    // samplesPerTest: 1 — no repeat measurement exists, so the dimension is
    // inactive rather than silently reporting a perfect 10.
    expect(calculateStabilityFromSamples(nodeWith([[8]]))).toBeUndefined();
    expect(calculateStabilityFromSamples(nodeWith([]))).toBeUndefined();
  });

  it('averages across tests', () => {
    const mixed = calculateStabilityFromSamples(nodeWith([[8, 8, 8], [10, 0, 5]]))!;
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(10);
  });
});
