import { describe, it, expect } from 'vitest';
import { varyModel } from '../../../electron/engine/modelvariation';
import type { EvaluationConfig, ModelRef } from '../../../src/types';

function makeConfig(): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0.3,
      modelVariation: { enabled: true, share: 0.1 },
    },
    population: { initialSize: 10, generationSize: 10, seedPrompt: 'test', fill: 'auto' },
    enabledModels: [
      { provider: 'openai', model: 'gpt-4' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      { provider: 'gemini', model: 'gemini-1.5-pro' },
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

describe('varyModel', () => {
  const baseModel: ModelRef = { provider: 'openai', model: 'gpt-4' };
  const enabledModels: ModelRef[] = [
    { provider: 'openai', model: 'gpt-4' },
    { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    { provider: 'gemini', model: 'gemini-1.5-pro' },
  ];

  it('returns a ModelVariationResult with model and changeLog', () => {
    const result = varyModel(baseModel, makeConfig(), true, enabledModels);
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('changeLog');
    expect(result.model).toHaveProperty('provider');
    expect(result.model).toHaveProperty('model');
  });

  it('when shouldVary=false, returns original model', () => {
    const result = varyModel(baseModel, makeConfig(), false, enabledModels);
    expect(result.model.provider).toBe('openai');
    expect(result.model.model).toBe('gpt-4');
    expect(result.changeLog).toHaveLength(0);
  });

  it('selects a different model from enabled list when shouldVary=true', () => {
    // Run multiple times — at least once it should pick something different
    let foundDifferent = false;
    for (let i = 0; i < 20; i++) {
      const result = varyModel(baseModel, makeConfig(), true, enabledModels);
      if (result.model.model !== 'gpt-4' || result.model.provider !== 'openai') {
        foundDifferent = true;
        break;
      }
    }
    expect(foundDifferent).toBe(true);
  });

  it('selected model is from enabledModels list', () => {
    for (let i = 0; i < 10; i++) {
      const result = varyModel(baseModel, makeConfig(), true, enabledModels);
      const found = enabledModels.some(
        m => m.provider === result.model.provider && m.model === result.model.model
      );
      expect(found).toBe(true);
    }
  });

  it('no-op when only one model is enabled', () => {
    const singleModel: ModelRef[] = [{ provider: 'openai', model: 'gpt-4' }];
    const result = varyModel(baseModel, makeConfig(), true, singleModel);
    expect(result.model.model).toBe('gpt-4');
    expect(result.model.provider).toBe('openai');
  });

  it('produces changelog entry when model changes', () => {
    // With 3 models and 20 tries, we should get at least one change
    for (let i = 0; i < 20; i++) {
      const result = varyModel(baseModel, makeConfig(), true, enabledModels);
      if (result.model.model !== 'gpt-4') {
        expect(result.changeLog.length).toBeGreaterThan(0);
        expect(result.changeLog[0].label).toBe('MODEL');
        return;
      }
    }
  });
});
