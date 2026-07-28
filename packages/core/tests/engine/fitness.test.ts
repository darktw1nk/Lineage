import { describe, it, expect } from 'vitest';
import { calculateFitness, evaluateTestResult } from '../../src/engine/fitness';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

// Helper to create test results that produce a given quality score
function makeTestResults(qualityScore: number): any[] {
  if (qualityScore === 0) return [];
  return [{ testId: 't1', passed: true, score: qualityScore, promptTokens: 10, completionTokens: 10, latencyMs: 100 }];
}

// Helper to create a minimal candidate node with metrics
// Quality is derived from node.tests (average score), not node.metrics.quality
function makeNode(overrides: Partial<CandidateNode['metrics']> = {}): CandidateNode {
  const quality = overrides.quality ?? 7;
  return {
    id: 'node-1',
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt: 'test prompt',
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
    tests: makeTestResults(quality),
    metrics: {
      quality,
      safety: 8,
      costUSD: 0.01,
      latencyMs: 500,
      stability: 9,
      fitness: 0,
      ...overrides,
    },
  };
}

// Helper to create a minimal config for fitness calculation
function makeConfig(overrides: Partial<EvaluationConfig['fitness']> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: { initialSize: 10, generationSize: 10, seedPrompt: 'test', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-4' }],
    testSet: [],
    fitness: {
      weights: { quality: 1.0 },
      ...overrides,
    },
    targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    serviceModelMaxTokens: 20000,
    retries: 3,
  };
}

describe('calculateFitness', () => {
  it('returns a FitnessResult with fitness property', () => {
    const node = makeNode({ quality: 8 });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result).toHaveProperty('fitness');
    expect(result).toHaveProperty('quality');
    expect(typeof result.fitness).toBe('number');
  });

  it('quality-only weight produces fitness proportional to quality', () => {
    const node = makeNode({ quality: 8 });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result.fitness).toBeGreaterThan(0);
  });

  it('higher quality produces higher fitness when quality is only weight', () => {
    const config = makeConfig({ weights: { quality: 1.0 } });
    const high = calculateFitness(makeNode({ quality: 9 }), config);
    const low = calculateFitness(makeNode({ quality: 3 }), config);
    expect(high.fitness).toBeGreaterThan(low.fitness);
  });

  it('zero quality produces zero or near-zero fitness with quality-only weight', () => {
    const node = makeNode({ quality: 0 });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result.fitness).toBeLessThanOrEqual(0.01);
  });

  it('respects cost weight — lower cost = higher fitness', () => {
    const config = makeConfig({
      weights: { quality: 0.5, cost: 0.5 },
      costNorm: { mode: 'absolute', maxUSDPerCall: 0.1 },
    });
    const cheap = calculateFitness(makeNode({ quality: 7, costUSD: 0.001 }), config);
    const expensive = calculateFitness(makeNode({ quality: 7, costUSD: 0.09 }), config);
    expect(cheap.fitness).toBeGreaterThan(expensive.fitness);
  });

  it('respects latency weight — lower latency = higher fitness', () => {
    const config = makeConfig({
      weights: { quality: 0.5, latency: 0.5 },
      latencyNorm: { mode: 'absolute', maxMs: 5000 },
    });
    const fast = calculateFitness(makeNode({ quality: 7, latencyMs: 100 }), config);
    const slow = calculateFitness(makeNode({ quality: 7, latencyMs: 4000 }), config);
    expect(fast.fitness).toBeGreaterThan(slow.fitness);
  });

  it('includes safety in fitness when safety weight is set', () => {
    const config = makeConfig({
      weights: { quality: 0.5, safety: 0.5 },
    });
    const safe = calculateFitness(makeNode({ quality: 7, safety: 10 }), config);
    const unsafe = calculateFitness(makeNode({ quality: 7, safety: 2 }), config);
    expect(safe.fitness).toBeGreaterThan(unsafe.fitness);
  });

  it('fitness is non-negative', () => {
    const node = makeNode({ quality: 0, safety: 0, costUSD: 1, latencyMs: 10000 });
    const config = makeConfig({
      weights: { quality: 0.25, safety: 0.25, cost: 0.25, latency: 0.25 },
      costNorm: { mode: 'absolute', maxUSDPerCall: 0.1 },
      latencyNorm: { mode: 'absolute', maxMs: 1000 },
    });
    const result = calculateFitness(node, config);
    expect(result.fitness).toBeGreaterThanOrEqual(0);
  });

  it('relative cost mode uses dynamicMaxCost when provided', () => {
    const config = makeConfig({
      weights: { quality: 0.5, cost: 0.5 },
      costNorm: { mode: 'relative', maxUSDPerCall: 1 },
    });
    // With dynamic max of 0.1, a cost of 0.05 should score well
    const result = calculateFitness(makeNode({ quality: 7, costUSD: 0.05 }), config, 0.1);
    expect(result.fitness).toBeGreaterThan(0);
  });
});

describe('evaluateTestResult', () => {
  it('returns passed=true and score=10 for exact match', () => {
    const testCase = {
      id: 'test-1',
      name: 'exact test',
      mode: 'exact_match' as const,
      prompt: 'What is 2+2?',
      expected: '4',
    };
    const result = evaluateTestResult(testCase, '4', 'exact_match');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(10);
  });

  it('returns passed=false for non-matching exact match', () => {
    const testCase = {
      id: 'test-1',
      name: 'exact test',
      mode: 'exact_match' as const,
      prompt: 'What is 2+2?',
      expected: '4',
    };
    const result = evaluateTestResult(testCase, '5', 'exact_match');
    expect(result.passed).toBe(false);
  });

  it('uses levenshtein distance when distanceMetric is levenshtein', () => {
    const testCase = {
      id: 'test-1',
      name: 'distance test',
      mode: 'exact_match' as const,
      prompt: 'test',
      expected: 'hello',
      grading: { distanceMetric: 'levenshtein' as const },
    };
    const result = evaluateTestResult(testCase, 'hallo', 'exact_match');
    // 'hallo' vs 'hello' — 1 edit distance, should score high
    expect(result.score).toBeGreaterThan(5);
  });

  it('uses json_diff when distanceMetric is json_diff', () => {
    const testCase = {
      id: 'test-1',
      name: 'json test',
      mode: 'exact_match' as const,
      prompt: 'test',
      expected: '{"a":1,"b":2}',
      grading: { distanceMetric: 'json_diff' as const },
    };
    const result = evaluateTestResult(testCase, '{"a":1,"b":2}', 'exact_match');
    expect(result.score).toBe(10);
  });

  it('uses numeric_abs when distanceMetric is numeric_abs', () => {
    const testCase = {
      id: 'test-1',
      name: 'numeric test',
      mode: 'exact_match' as const,
      prompt: 'test',
      expected: '100',
      grading: { distanceMetric: 'numeric_abs' as const },
    };
    const result = evaluateTestResult(testCase, '100', 'exact_match');
    expect(result.score).toBe(10);
  });

  it('strictZeroOnDeviation returns 0 for any mismatch', () => {
    const testCase = {
      id: 'test-1',
      name: 'strict test',
      mode: 'exact_match' as const,
      prompt: 'test',
      expected: 'exact',
      grading: { strictZeroOnDeviation: true },
    };
    const result = evaluateTestResult(testCase, 'almost exact', 'exact_match');
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('score is always between 0 and 10', () => {
    const testCase = {
      id: 'test-1',
      name: 'bounds test',
      mode: 'exact_match' as const,
      prompt: 'test',
      expected: 'abc',
      grading: { distanceMetric: 'levenshtein' as const },
    };
    const result = evaluateTestResult(testCase, 'xyz completely different long string', 'exact_match');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
  });
});
