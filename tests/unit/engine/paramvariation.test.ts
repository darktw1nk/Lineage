import { describe, it, expect } from 'vitest';
import { varyParameters, getDefaultTemperature } from '../../../electron/engine/paramvariation';
import type { EvaluationConfig } from '../../../src/types';

function makeConfig(paramVariation?: any): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0.3,
      paramVariation: paramVariation ?? {
        enabled: true,
        share: 0.1,
        temperature: { enabled: true, min: 0.0, max: 2.0 },
      },
    },
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

describe('varyParameters', () => {
  it('returns a ParamVariationResult with temperature and changeLog', () => {
    const result = varyParameters(0.7, makeConfig(), true);
    expect(result).toHaveProperty('temperature');
    expect(result).toHaveProperty('changeLog');
    expect(typeof result.temperature).toBe('number');
    expect(Array.isArray(result.changeLog)).toBe(true);
  });

  it('when shouldVary=false, returns original temperature', () => {
    const result = varyParameters(0.7, makeConfig(), false);
    expect(result.temperature).toBe(0.7);
    expect(result.changeLog).toHaveLength(0);
  });

  it('varied temperature stays within configured bounds', () => {
    const config = makeConfig({
      enabled: true,
      share: 0.1,
      temperature: { enabled: true, min: 0.2, max: 1.5 },
    });
    // Run multiple times to check bounds
    for (let i = 0; i < 20; i++) {
      const result = varyParameters(0.7, config, true);
      expect(result.temperature).toBeGreaterThanOrEqual(0.2);
      expect(result.temperature).toBeLessThanOrEqual(1.5);
    }
  });

  it('produces changelog entry when varying', () => {
    const result = varyParameters(0.7, makeConfig(), true);
    if (result.temperature !== 0.7) {
      expect(result.changeLog.length).toBeGreaterThan(0);
      expect(result.changeLog[0].label).toBe('PARAM');
    }
  });

  it('temperature is always non-negative', () => {
    const config = makeConfig({
      enabled: true,
      share: 0.1,
      temperature: { enabled: true, min: 0.0, max: 2.0 },
    });
    for (let i = 0; i < 20; i++) {
      const result = varyParameters(0.1, config, true);
      expect(result.temperature).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('getDefaultTemperature', () => {
  it('returns middle of range when param variation is enabled', () => {
    const config = makeConfig({
      enabled: true,
      share: 0.1,
      temperature: { enabled: true, min: 0.0, max: 2.0 },
    });
    const temp = getDefaultTemperature(config);
    expect(temp).toBe(1.0); // middle of 0..2
  });

  it('respects min=0 (zero is a valid temperature)', () => {
    const config = makeConfig({
      enabled: true,
      share: 0.1,
      temperature: { enabled: true, min: 0, max: 1.0 },
    });
    const temp = getDefaultTemperature(config);
    expect(temp).toBe(0.5); // middle of 0..1
  });

  it('returns 0.7 when param variation is disabled', () => {
    const config = makeConfig({
      enabled: false,
      share: 0,
    });
    const temp = getDefaultTemperature(config);
    expect(temp).toBe(0.7);
  });

  it('returns middle of custom range', () => {
    const config = makeConfig({
      enabled: true,
      share: 0.1,
      temperature: { enabled: true, min: 0.5, max: 1.5 },
    });
    const temp = getDefaultTemperature(config);
    expect(temp).toBe(1.0); // middle of 0.5..1.5
  });
});
