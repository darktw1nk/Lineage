import { describe, it, expect } from 'vitest';
import { selectTopPerformers } from '../../../electron/engine/generation';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

function makeNode(id: string, fitness: number | undefined, status: string = 'finished'): CandidateNode {
  return {
    id,
    generation: 0,
    lineageParents: [],
    status: status as any,
    prompt: `prompt for ${id}`,
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
    tests: [],
    metrics: fitness !== undefined ? { quality: fitness, fitness } : undefined,
  };
}

function makeConfig(overrides: Partial<EvaluationConfig['selection']> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 3, ...overrides },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: { initialSize: 10, generationSize: 10, seedPrompt: 'test', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-4' }],
    testSet: [],
    fitness: { weights: { quality: 1.0 } },
    targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    serviceModelMaxTokens: 20000,
    retries: 3,
  };
}

describe('selectTopPerformers', () => {
  describe('topk policy', () => {
    it('selects exactly K nodes', () => {
      const nodes = [
        makeNode('a', 9),
        makeNode('b', 7),
        makeNode('c', 5),
        makeNode('d', 3),
        makeNode('e', 1),
      ];
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers(nodes, config);
      expect(result).toHaveLength(3);
    });

    it('selects nodes with highest fitness', () => {
      const nodes = [
        makeNode('a', 9),
        makeNode('b', 7),
        makeNode('c', 5),
        makeNode('d', 3),
        makeNode('e', 1),
      ];
      const config = makeConfig({ policy: 'topk', topK: 2 });
      const result = selectTopPerformers(nodes, config);
      const ids = result.map(n => n.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });

    it('returns fewer than K when not enough finished nodes', () => {
      const nodes = [
        makeNode('a', 9),
        makeNode('b', undefined, 'failed'),
      ];
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers(nodes, config);
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('excludes nodes without fitness', () => {
      const nodes = [
        makeNode('a', 9),
        makeNode('b', undefined),
        makeNode('c', 5),
      ];
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers(nodes, config);
      const ids = result.map(n => n.id);
      expect(ids).not.toContain('b');
    });

    it('excludes non-finished nodes', () => {
      const nodes = [
        makeNode('a', 9),
        makeNode('b', 7, 'in_progress'),
        makeNode('c', 5, 'failed'),
        makeNode('d', 3),
      ];
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers(nodes, config);
      const ids = result.map(n => n.id);
      expect(ids).not.toContain('b');
      expect(ids).not.toContain('c');
    });
  });

  describe('topp policy', () => {
    it('selects nodes by cumulative fitness probability', () => {
      const nodes = [
        makeNode('a', 10),
        makeNode('b', 8),
        makeNode('c', 6),
        makeNode('d', 4),
        makeNode('e', 2),
      ];
      const config = makeConfig({ policy: 'topp', topP: 0.5 });
      const result = selectTopPerformers(nodes, config);
      // Top-P 0.5 should select the highest-fitness nodes covering ~50% of cumulative fitness
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThan(nodes.length);
    });

    it('topP=1.0 selects all finished nodes with fitness', () => {
      const nodes = [
        makeNode('a', 10),
        makeNode('b', 8),
        makeNode('c', 6),
      ];
      const config = makeConfig({ policy: 'topp', topP: 1.0 });
      const result = selectTopPerformers(nodes, config);
      expect(result).toHaveLength(3);
    });

    it('always selects at least one node', () => {
      const nodes = [
        makeNode('a', 10),
        makeNode('b', 8),
        makeNode('c', 6),
      ];
      const config = makeConfig({ policy: 'topp', topP: 0.01 });
      const result = selectTopPerformers(nodes, config);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes non-finished nodes', () => {
      const nodes = [
        makeNode('a', 10),
        makeNode('b', 8, 'failed'),
      ];
      const config = makeConfig({ policy: 'topp', topP: 1.0 });
      const result = selectTopPerformers(nodes, config);
      const ids = result.map(n => n.id);
      expect(ids).not.toContain('b');
    });
  });

  describe('edge cases', () => {
    it('returns empty array when no nodes have fitness', () => {
      const nodes = [
        makeNode('a', undefined),
        makeNode('b', undefined),
      ];
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers(nodes, config);
      expect(result).toHaveLength(0);
    });

    it('handles empty generation', () => {
      const config = makeConfig({ policy: 'topk', topK: 3 });
      const result = selectTopPerformers([], config);
      expect(result).toHaveLength(0);
    });

    it('handles single node', () => {
      const nodes = [makeNode('a', 5)];
      const config = makeConfig({ policy: 'topk', topK: 1 });
      const result = selectTopPerformers(nodes, config);
      expect(result).toHaveLength(1);
    });
  });
});
