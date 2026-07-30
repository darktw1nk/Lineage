import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { calculateFitness, resetFitnessWarnings } from '../../src/engine/fitness.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * `costNorm.maxUSDPerCall` and `latencyNorm.maxMs` are per-CALL caps, but
 * node.metrics.costUSD and node.metrics.latencyMs are per-CANDIDATE totals
 * (evaluator_v2 sums them across every test). So the same prompt, the same
 * model and the same per-call cost and latency scored differently purely
 * because the test set was longer — and past a certain length the dimension
 * saturated, making targetFitness unreachable and the dimension inert.
 */
const PER_CALL_MS = 1200;
const PER_CALL_USD = 0.000016;

/** A node with `testCount` tests, each one call at identical cost and latency. */
function node(testCount: number, samplesPerTest = 1): CandidateNode {
  const tests = Array.from({ length: testCount }, (_, i) => ({
    testId: `t${i}`, passed: true, score: 10,
    // Tokens are SUMMED across samples by the engine...
    promptTokens: 10 * samplesPerTest, completionTokens: 10 * samplesPerTest,
    // ...but latency is the MEAN across samples.
    latencyMs: PER_CALL_MS,
    outputText: 'o',
    ...(samplesPerTest > 1 ? { samples: Array(samplesPerTest).fill(10) } : {}),
  }));
  return {
    id: `n${testCount}`, generation: 0, lineageParents: [], status: 'finished', prompt: 'p',
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [], tests,
    metrics: {
      quality: 10, fitness: 0,
      costUSD: PER_CALL_USD * testCount * samplesPerTest, // engine sums every call
      latencyMs: PER_CALL_MS * testCount,                 // engine sums per-test means
    },
  } as any;
}

const config = (weights: any, norms: any = {}) => ({
  id: 'c', name: 'c',
  fitness: { weights, ...norms },
  selection: {}, operators: {}, population: {}, targets: {},
  enabledModels: [], serviceModel: { provider: 'x', model: 'y' },
  testSet: [], parallelLimit: 1,
} as unknown as EvaluationConfig);

// Norms taken verbatim from docs/cli.md.
const NORMS = {
  costNorm: { mode: 'absolute', maxUSDPerCall: 0.01 },
  latencyNorm: { mode: 'absolute', maxMs: 5000 },
};
const WEIGHTS = { quality: 0.8, cost: 0.1, latency: 0.1 };

beforeEach(() => resetFitnessWarnings());

describe('cost and latency normalise per CALL, not per candidate', () => {
  it('test-set length does not change a candidate\'s fitness', () => {
    // Measured before the fix: 2 tests -> 9.5194 (stopReason target),
    // 10 tests -> 8.9968, so targetFitness 9.0 became unreachable purely
    // because the test set was longer.
    const short = calculateFitness(node(2), config(WEIGHTS, NORMS)).fitness;
    const long = calculateFitness(node(10), config(WEIGHTS, NORMS)).fitness;
    expect(long).toBeCloseTo(short, 6);
  });

  it('a flawless candidate can still reach 10 with a long test set', () => {
    // The dimension saturated: latency 12000ms against a 5000ms cap scored 0,
    // capping a 10/10 candidate at 8.9968.
    const { fitness } = calculateFitness(node(10), config(WEIGHTS, NORMS));
    expect(fitness).toBeGreaterThan(9.0);
  });

  it('keeps ranking signal — a genuinely slower candidate still scores lower', () => {
    const fast = node(4);
    const slow = node(4);
    (slow.metrics as any).latencyMs = PER_CALL_MS * 4 * 3; // 3x slower per call
    const fastFitness = calculateFitness(fast, config(WEIGHTS, NORMS)).fitness;
    const slowFitness = calculateFitness(slow, config(WEIGHTS, NORMS)).fitness;
    expect(slowFitness).toBeLessThan(fastFitness);
  });

  it('accounts for samplesPerTest when dividing cost', () => {
    // Cost is summed across samples, so 4 tests x 3 samples is 12 calls.
    const oneSample = calculateFitness(node(4, 1), config(WEIGHTS, NORMS)).fitness;
    const threeSamples = calculateFitness(node(4, 3), config(WEIGHTS, NORMS)).fitness;
    expect(threeSamples).toBeCloseTo(oneSample, 6);
  });
});

describe('relative mode keeps its dynamic range', () => {
  // The per-call fix divided the NUMERATOR by the call count but left the
  // dynamic max a per-NODE total (evaluator_v2 computes it as
  // Math.max(...nodes.map(n => n.metrics.costUSD))). The dimension's range
  // collapsed by a factor of the test count: two candidates 10x apart in cost
  // scored 7.0000 vs 7.4500 — a 0.45 spread where it used to be 4.5.
  const RELATIVE = {
    costNorm: { mode: 'relative', maxUSDPerCall: 0.01 },
    latencyNorm: { mode: 'relative', maxMs: 5000 },
  };

  it('a 10x cost difference still separates two candidates', () => {
    const cheap = node(10);
    const dear = node(10);
    (dear.metrics as any).costUSD = (cheap.metrics as any).costUSD * 10;
    // dynamicMaxCost is what the engine passes: the largest per-NODE total.
    const dynamicMax = (dear.metrics as any).costUSD;

    const cfg = config({ quality: 0.5, cost: 0.5 }, RELATIVE);
    const cheapFitness = calculateFitness(cheap, cfg, dynamicMax).fitness;
    const dearFitness = calculateFitness(dear, cfg, dynamicMax).fitness;

    expect(cheapFitness - dearFitness).toBeGreaterThan(2);
  });
});
