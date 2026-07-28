import { describe, it, expect } from 'vitest';
import { varyParameters } from '../../src/engine/paramvariation';
import { varyModel } from '../../src/engine/modelvariation';
import { createShellPopulation } from '../../src/engine/operators_v2';
import type { EvaluationConfig, ModelRef } from '../../../src/types';

function makeConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0.3,
      paramVariation: { enabled: true, share: 0.1, temperature: { enabled: true, min: 0.0, max: 2.0 } },
      modelVariation: { enabled: true, share: 0.1 },
    },
    population: { initialSize: 5, generationSize: 5, seedPrompt: 'test prompt', fill: 'auto' },
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
    ...overrides,
  };
}

describe('varyParameters edge cases', () => {
  it('min == max returns exactly that value', () => {
    const config = makeConfig({
      operators: {
        mutationShare: 0.5,
        crossoverShare: 0.3,
        paramVariation: { enabled: true, share: 0.1, temperature: { enabled: true, min: 0.7, max: 0.7 } },
      },
    });
    for (let i = 0; i < 10; i++) {
      const result = varyParameters(0.5, config, true);
      expect(result.temperature).toBeCloseTo(0.7, 10);
    }
  });

  it('min=0 actually produces 0-range temperatures', () => {
    const config = makeConfig({
      operators: {
        mutationShare: 0.5,
        crossoverShare: 0.3,
        paramVariation: { enabled: true, share: 0.1, temperature: { enabled: true, min: 0, max: 0.5 } },
      },
    });
    let foundNearZero = false;
    for (let i = 0; i < 50; i++) {
      const result = varyParameters(0.7, config, true);
      expect(result.temperature).toBeGreaterThanOrEqual(0);
      expect(result.temperature).toBeLessThanOrEqual(0.5);
      if (result.temperature < 0.1) foundNearZero = true;
    }
    expect(foundNearZero).toBe(true);
  });

  it('disabled param variation is no-op even when shouldVary=true', () => {
    const config = makeConfig({
      operators: {
        mutationShare: 0.5,
        crossoverShare: 0.3,
        paramVariation: { enabled: false, share: 0.1 },
      },
    });
    const result = varyParameters(0.7, config, true);
    expect(result.temperature).toBe(0.7);
    expect(result.changeLog).toHaveLength(0);
  });
});

describe('varyModel edge cases', () => {
  const baseModel: ModelRef = { provider: 'openai', model: 'gpt-4' };

  it('empty enabled models list returns base model', () => {
    const result = varyModel(baseModel, makeConfig(), true, []);
    // Should not crash; returns base model since no alternatives
    expect(result.model.model).toBe('gpt-4');
  });

  it('guarantees different model when multiple available', () => {
    const models: ModelRef[] = [
      { provider: 'openai', model: 'gpt-4' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    ];
    // With only 2 models, variation MUST pick the other one
    const result = varyModel(baseModel, makeConfig(), true, models);
    expect(result.model.model).toBe('claude-3-5-sonnet');
  });
});

describe('createShellPopulation edge cases', () => {
  it('initialSize=1 creates single baseline node', () => {
    const config = makeConfig({ population: { initialSize: 1, generationSize: 5, seedPrompt: 'test', fill: 'auto' } });
    const nodes = createShellPopulation(config);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe('awaiting');
  });

  it('throws on empty seed prompt in auto mode', () => {
    const config = makeConfig({ population: { initialSize: 5, generationSize: 5, seedPrompt: '', fill: 'auto' } });
    expect(() => createShellPopulation(config)).toThrow();
  });

  it('manual mode requires manualPrompts', () => {
    const config = makeConfig({ population: { initialSize: 5, generationSize: 5, seedPrompt: 'test', fill: 'manual' } as any });
    expect(() => createShellPopulation(config)).toThrow();
  });

  it('manual mode creates nodes from provided prompts', () => {
    const config = makeConfig({
      population: {
        initialSize: 2,
        generationSize: 2,
        seedPrompt: '',
        fill: 'manual',
        manualPrompts: [
          { prompt: 'Manual prompt A', model: { provider: 'openai', model: 'gpt-4' } },
          { prompt: 'Manual prompt B', model: { provider: 'anthropic', model: 'claude-3-5-sonnet' } },
        ],
      } as any,
    });
    const nodes = createShellPopulation(config);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].prompt).toBe('Manual prompt A');
    expect(nodes[1].prompt).toBe('Manual prompt B');
  });

  it('single enabled model assigns same model to all nodes', () => {
    const config = makeConfig({
      enabledModels: [{ provider: 'openai', model: 'gpt-4' }],
      population: { initialSize: 4, generationSize: 4, seedPrompt: 'test', fill: 'auto' },
    });
    const nodes = createShellPopulation(config);
    for (const node of nodes) {
      expect(node.params.model.model).toBe('gpt-4');
    }
  });
});
