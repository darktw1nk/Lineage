import { describe, it, expect, beforeEach } from 'vitest';
import { calculateStabilityFromSamples, calculateFitness, resetFitnessWarnings } from '../../src/engine/fitness.js';
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

describe('an UNMEASURABLE stability weight does not inflate fitness', () => {
  beforeEach(() => resetFitnessWarnings());

  const configWith = (weights: any) => ({
    id: 'c', name: 'c',
    fitness: { weights },
    selection: {}, operators: {}, population: {}, targets: {},
    enabledModels: [], serviceModel: { provider: 'x', model: 'y' },
    testSet: [], parallelLimit: 1,
  } as any);

  // A node scored 1/10 on every test, with samplesPerTest 1 (THE DEFAULT), so
  // metrics.stability is undefined.
  const badNode = () => ({
    ...nodeWith([[1], [1]]),
    metrics: { quality: 1, fitness: 0, costUSD: 0, latencyMs: 1 },
  } as any);

  it('does not award a free 10 for a dimension that was never measured', () => {
    // calculateStabilityScore used to `?? 10` — the BEST possible score, handed
    // out for free. With {quality: 0.2, stability: 0.8} a run whose judge scored
    // every answer 1/10 reported fitness 8.2 and stopped with reason "target".
    const { fitness } = calculateFitness(badNode(), configWith({ quality: 0.2, stability: 0.8 }));
    expect(fitness).toBeCloseTo(1, 5);
  });

  it('scores identically to the same config without the stability weight', () => {
    // Disabling drops the weight from the denominator, so ranking is unchanged
    // rather than capped.
    const withStability = calculateFitness(badNode(), configWith({ quality: 0.5, stability: 0.5 })).fitness;
    const withoutStability = calculateFitness(badNode(), configWith({ quality: 0.5 })).fitness;
    expect(withStability).toBeCloseTo(withoutStability, 5);
  });

  it('does the same for an unmeasurable SAFETY weight', () => {
    // Identical bug, identical shape: calculateSafetyScore fell back to 10, and
    // the guardrail pass only runs when fitness.guardrails is non-empty. So
    // {quality: 0.5, safety: 0.5} with no guardrails handed every candidate
    // half its score for free.
    const { fitness } = calculateFitness(badNode(), configWith({ quality: 0.5, safety: 0.5 }));
    expect(fitness).toBeCloseTo(1, 5);
  });

  it('still counts safety when guardrails DID measure it', () => {
    const measured = { ...nodeWith([[1], [1]]), metrics: { quality: 1, fitness: 0, safety: 3, costUSD: 0, latencyMs: 1 } } as any;
    const { fitness } = calculateFitness(measured, configWith({ quality: 0.5, safety: 0.5 }));
    expect(fitness).toBeCloseTo(2, 5); // 0.5*1 + 0.5*3
  });

  it('still counts stability when it IS measured', () => {
    const measured = { ...nodeWith([[1, 1], [1, 1]]), metrics: { quality: 1, fitness: 0, stability: 10, costUSD: 0, latencyMs: 1 } } as any;
    const { fitness } = calculateFitness(measured, configWith({ quality: 0.5, stability: 0.5 }));
    expect(fitness).toBeCloseTo(5.5, 5); // 0.5*1 + 0.5*10
  });
});
