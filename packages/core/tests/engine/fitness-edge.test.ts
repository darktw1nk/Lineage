import { describe, it, expect } from 'vitest';
import { calculateFitness, evaluateTestResult } from '../../src/engine/fitness';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

function makeTestResults(score: number): any[] {
  if (score === 0) return [];
  return [{ testId: 't1', passed: true, score, promptTokens: 10, completionTokens: 10, latencyMs: 100 }];
}

function makeNode(overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    id: 'node-1',
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt: 'test prompt',
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
    tests: makeTestResults(7),
    metrics: { quality: 7, safety: 8, costUSD: 0.01, latencyMs: 500, stability: 9, fitness: 0 },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EvaluationConfig['fitness']> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: { initialSize: 10, generationSize: 10, seedPrompt: 'test', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-4' }],
    testSet: [],
    fitness: { weights: { quality: 1.0 }, ...overrides },
    targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    serviceModelMaxTokens: 20000,
    retries: 3,
  };
}

describe('calculateFitness edge cases', () => {
  it('node with no tests gets quality=0', () => {
    const node = makeNode({ tests: [] });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result.quality).toBe(0);
    expect(result.fitness).toBe(0);
  });

  it('node with undefined tests gets quality=0', () => {
    const node = makeNode({ tests: undefined });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result.quality).toBe(0);
  });

  it('all weights zero falls back to quality=1 weight', () => {
    const config = makeConfig({ weights: { quality: 0, safety: 0, cost: 0, latency: 0, stability: 0 } });
    const result = calculateFitness(makeNode(), config);
    // With all-zero weights, normalizeWeights returns {quality: 1}
    expect(result).toHaveProperty('fitness');
    expect(typeof result.fitness).toBe('number');
    expect(Number.isNaN(result.fitness)).toBe(false);
  });

  it('does not produce NaN or Infinity fitness', () => {
    const configs = [
      makeConfig({ weights: { quality: 1.0 } }),
      makeConfig({ weights: { quality: 0.5, cost: 0.5 }, costNorm: { mode: 'absolute', maxUSDPerCall: 0.1 } }),
      makeConfig({ weights: { quality: 0.5, latency: 0.5 }, latencyNorm: { mode: 'absolute', maxMs: 1000 } }),
    ];
    const nodes = [
      makeNode({ tests: [] }),
      makeNode({ tests: makeTestResults(10), metrics: { costUSD: 0, latencyMs: 0, fitness: 0 } }),
      makeNode({ tests: makeTestResults(5), metrics: { costUSD: 999, latencyMs: 999999, fitness: 0 } }),
    ];
    for (const config of configs) {
      for (const node of nodes) {
        const result = calculateFitness(node, config);
        expect(Number.isNaN(result.fitness)).toBe(false);
        expect(Number.isFinite(result.fitness)).toBe(true);
      }
    }
  });

  it('cost exceeding maxUSDPerCall is clamped (score=0, not negative)', () => {
    const config = makeConfig({
      weights: { quality: 0.5, cost: 0.5 },
      costNorm: { mode: 'absolute', maxUSDPerCall: 0.01 },
    });
    const node = makeNode({
      tests: makeTestResults(7),
      metrics: { quality: 7, costUSD: 1.0, fitness: 0 },
    });
    const result = calculateFitness(node, config);
    expect(result.fitness).toBeGreaterThanOrEqual(0);
  });

  it('latency exceeding maxMs is clamped (score=0, not negative)', () => {
    const config = makeConfig({
      weights: { quality: 0.5, latency: 0.5 },
      latencyNorm: { mode: 'absolute', maxMs: 100 },
    });
    const node = makeNode({
      tests: makeTestResults(7),
      metrics: { quality: 7, latencyMs: 100000, fitness: 0 },
    });
    const result = calculateFitness(node, config);
    expect(result.fitness).toBeGreaterThanOrEqual(0);
  });

  it('multiple tests averages their scores for quality', () => {
    const node = makeNode({
      tests: [
        { testId: 't1', passed: true, score: 10, promptTokens: 10, completionTokens: 10, latencyMs: 100 },
        { testId: 't2', passed: false, score: 2, promptTokens: 10, completionTokens: 10, latencyMs: 100 },
        { testId: 't3', passed: true, score: 6, promptTokens: 10, completionTokens: 10, latencyMs: 100 },
      ],
    });
    const config = makeConfig({ weights: { quality: 1.0 } });
    const result = calculateFitness(node, config);
    expect(result.quality).toBe(6); // (10+2+6)/3
  });

  it('relative cost mode with dynamicMaxCost=0 does not crash', () => {
    const config = makeConfig({
      weights: { quality: 0.5, cost: 0.5 },
      costNorm: { mode: 'relative', maxUSDPerCall: 1 },
    });
    const node = makeNode({ tests: makeTestResults(7), metrics: { quality: 7, costUSD: 0.01, fitness: 0 } });
    // dynamicMaxCost=0 could cause division by zero
    const result = calculateFitness(node, config, 0);
    expect(Number.isFinite(result.fitness)).toBe(true);
  });
});

describe('evaluateTestResult edge cases', () => {
  it('exact match with empty expected and empty output scores 10', () => {
    const testCase = { id: 't1', name: 'empty', mode: 'exact_match' as const, prompt: 'test', expected: '' };
    const result = evaluateTestResult(testCase, '', 'exact_match');
    expect(result.score).toBe(10);
    expect(result.passed).toBe(true);
  });

  it('exact match with no expected field uses empty string', () => {
    const testCase = { id: 't1', name: 'no expected', mode: 'exact_match' as const, prompt: 'test' };
    const result = evaluateTestResult(testCase, '', 'exact_match');
    expect(result.score).toBe(10);
  });

  it('throws error for llm_grade mode (must use async version)', () => {
    const testCase = { id: 't1', name: 'llm test', mode: 'llm_grade' as const, prompt: 'test' };
    expect(() => evaluateTestResult(testCase, 'output', 'llm_grade')).toThrow();
  });

  it('levenshtein with very long strings does not crash', () => {
    const longStr = 'a'.repeat(1000);
    const testCase = {
      id: 't1', name: 'long', mode: 'exact_match' as const,
      prompt: 'test', expected: longStr,
      grading: { distanceMetric: 'levenshtein' as const },
    };
    const result = evaluateTestResult(testCase, longStr + 'b', 'exact_match');
    expect(result.score).toBeGreaterThan(9); // Very close match
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('numeric_abs with zero expected and zero output scores 10', () => {
    const testCase = {
      id: 't1', name: 'zero', mode: 'exact_match' as const,
      prompt: 'test', expected: '0',
      grading: { distanceMetric: 'numeric_abs' as const },
    };
    const result = evaluateTestResult(testCase, '0', 'exact_match');
    expect(result.score).toBe(10);
  });

  it('default distance metric is levenshtein when no grading specified', () => {
    const testCase = {
      id: 't1', name: 'default', mode: 'exact_match' as const,
      prompt: 'test', expected: 'hello',
    };
    // 'hallo' vs 'hello' — levenshtein distance 1
    const result = evaluateTestResult(testCase, 'hallo', 'exact_match');
    expect(result.score).toBeGreaterThan(5);
  });

  it('passed threshold is score >= 7', () => {
    const testCase = {
      id: 't1', name: 'threshold', mode: 'exact_match' as const,
      prompt: 'test', expected: 'hello world',
      grading: { distanceMetric: 'levenshtein' as const },
    };
    // Exact match should pass
    const exact = evaluateTestResult(testCase, 'hello world', 'exact_match');
    expect(exact.passed).toBe(true);
    expect(exact.score).toBe(10);

    // Very different should fail
    const bad = evaluateTestResult(testCase, 'completely different text here', 'exact_match');
    expect(bad.passed).toBe(false);
  });
});
