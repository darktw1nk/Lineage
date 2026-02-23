import { describe, it, expect } from 'vitest';
import { createShellPopulation } from '../../../electron/engine/operators_v2';
import type { EvaluationConfig } from '../../../src/types';

function makeConfig(overrides: Partial<EvaluationConfig['population']> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: {
      initialSize: 5,
      generationSize: 5,
      seedPrompt: 'You are a helpful assistant.',
      fill: 'auto',
      ...overrides,
    },
    enabledModels: [
      { provider: 'openai', model: 'gpt-4' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    ],
    testSet: [],
    fitness: { weights: { quality: 1.0 } },
    targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    serviceModelMaxTokens: 20000,
    retries: 3,
  };
}

describe('createShellPopulation', () => {
  it('creates correct number of nodes (initialSize)', () => {
    const config = makeConfig({ initialSize: 8 });
    const nodes = createShellPopulation(config);
    expect(nodes).toHaveLength(8);
  });

  it('all nodes are in generation 0', () => {
    const nodes = createShellPopulation(makeConfig());
    for (const node of nodes) {
      expect(node.generation).toBe(0);
    }
  });

  it('all nodes have unique IDs', () => {
    const nodes = createShellPopulation(makeConfig());
    const ids = nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nodes have no lineage parents', () => {
    const nodes = createShellPopulation(makeConfig());
    for (const node of nodes) {
      expect(node.lineageParents).toHaveLength(0);
    }
  });

  it('auto fill: all nodes get the seed prompt', () => {
    const config = makeConfig({ fill: 'auto', seedPrompt: 'My seed prompt' });
    const nodes = createShellPopulation(config);
    for (const node of nodes) {
      expect(node.prompt).toBe('My seed prompt');
    }
  });

  it('first node has awaiting status, rest have pending', () => {
    const nodes = createShellPopulation(makeConfig());
    expect(nodes[0].status).toBe('awaiting');
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].status).toBe('pending');
    }
  });

  it('models are cycled through enabled models', () => {
    const config = makeConfig({ initialSize: 4 });
    const nodes = createShellPopulation(config);
    const models = nodes.map(n => n.params.model);
    // Should cycle: gpt-4, claude, gpt-4, claude
    expect(models[0].model).toBe('gpt-4');
    expect(models[1].model).toBe('claude-3-5-sonnet');
    expect(models[2].model).toBe('gpt-4');
    expect(models[3].model).toBe('claude-3-5-sonnet');
  });

  it('each node has valid CandidateNode structure', () => {
    const nodes = createShellPopulation(makeConfig());
    for (const node of nodes) {
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('generation');
      expect(node).toHaveProperty('lineageParents');
      expect(node).toHaveProperty('status');
      expect(node).toHaveProperty('prompt');
      expect(node).toHaveProperty('params');
      expect(node).toHaveProperty('changeLog');
      expect(node.params).toHaveProperty('model');
      expect(node.params).toHaveProperty('temperature');
    }
  });

  it('first node has seed prompt changelog, rest have pending mutation changelog', () => {
    const nodes = createShellPopulation(makeConfig());
    expect(nodes[0].changeLog).toHaveLength(1);
    expect(nodes[0].changeLog[0].label).toBe('MUTATION');
    expect(nodes[0].changeLog[0].text).toContain('Seed');
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].changeLog).toHaveLength(1);
      expect(nodes[i].changeLog[0].label).toBe('MUTATION');
    }
  });
});
