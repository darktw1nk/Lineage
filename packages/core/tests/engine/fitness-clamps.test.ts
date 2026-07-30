import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { calculateFitness, resetFitnessWarnings } from '../../src/engine/fitness.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * Mutation testing found these clamps entirely unprotected: dropping the
 * `Math.max(0, ...)` from either norm leaves 718 tests green. The source
 * comment records the defect this guards — a negative price drove costNorm
 * arbitrarily negative, costScore arbitrarily high, and a 1/10 prompt reached
 * fitness 84003 and won every selection forever.
 *
 * It is a live input path: OpenRouter publishes "-1" as a "price varies"
 * sentinel, and Settings lets a price be typed by hand.
 */
function node(over: Partial<CandidateNode['metrics']> = {}): CandidateNode {
  return {
    id: 'n', generation: 0, lineageParents: [], status: 'finished', prompt: 'p',
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [],
    tests: [{ testId: 't1', passed: true, score: 1, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
    metrics: { quality: 1, fitness: 0, costUSD: 0.001, latencyMs: 100, ...over },
  } as any;
}

const config = (weights: any, norms: any) => ({
  id: 'c', name: 'c',
  fitness: { weights, ...norms },
  selection: {}, operators: {}, population: {}, targets: {},
  enabledModels: [], serviceModel: { provider: 'x', model: 'y' },
  testSet: [], parallelLimit: 1,
} as unknown as EvaluationConfig);

const COST_CFG = config(
  { quality: 0.5, cost: 0.5 },
  { costNorm: { mode: 'absolute', maxUSDPerCall: 0.01 } },
);
const LATENCY_CFG = config(
  { quality: 0.5, latency: 0.5 },
  { latencyNorm: { mode: 'absolute', maxMs: 1000 } },
);

beforeEach(() => resetFitnessWarnings());

describe('a bad price cannot inflate fitness', () => {
  it('a negative cost scores no better than a free one', () => {
    const free = calculateFitness(node({ costUSD: 0 }), COST_CFG).fitness;
    const negative = calculateFitness(node({ costUSD: -1000 }), COST_CFG).fitness;
    expect(negative).toBeLessThanOrEqual(free);
    expect(negative).toBeLessThanOrEqual(10);
  });

  it('a negative latency scores no better than an instant one', () => {
    const instant = calculateFitness(node({ latencyMs: 0 }), LATENCY_CFG).fitness;
    const negative = calculateFitness(node({ latencyMs: -1_000_000 }), LATENCY_CFG).fitness;
    expect(negative).toBeLessThanOrEqual(instant);
    expect(negative).toBeLessThanOrEqual(10);
  });

  it('an enormous cost floors the dimension rather than going negative', () => {
    const { fitness } = calculateFitness(node({ costUSD: 1_000_000 }), COST_CFG);
    expect(fitness).toBeGreaterThanOrEqual(0);
    expect(fitness).toBeCloseTo(0.5 * 1, 5); // quality only; cost term is 0
  });

  it('fitness stays inside 0..10 for hostile metrics', () => {
    for (const metrics of [
      { costUSD: -1e9 }, { latencyMs: -1e9 },
      { costUSD: Number.MAX_VALUE }, { latencyMs: Number.MAX_VALUE },
      { costUSD: -0 }, { latencyMs: -0 },
    ]) {
      for (const cfg of [COST_CFG, LATENCY_CFG]) {
        const { fitness } = calculateFitness(node(metrics), cfg);
        expect(Number.isFinite(fitness)).toBe(true);
        expect(fitness).toBeGreaterThanOrEqual(0);
        expect(fitness).toBeLessThanOrEqual(10);
      }
    }
  });

  it('never returns a non-finite fitness', () => {
    // The `!Number.isFinite(fitness)` backstop is also unprotected; NaN would
    // sort unpredictably and NaN >= targetFitness is always false.
    for (const metrics of [{ costUSD: NaN }, { latencyMs: NaN }, { costUSD: Infinity }]) {
      for (const cfg of [COST_CFG, LATENCY_CFG]) {
        expect(Number.isFinite(calculateFitness(node(metrics), cfg).fitness)).toBe(true);
      }
    }
  });
});
