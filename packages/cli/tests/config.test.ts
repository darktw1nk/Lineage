import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadCliConfig, validateCliConfig, toEvaluationConfig, extractConfigKeys } from '../src/config.js';
import type { CliConfig } from '../src/config.js';

const MINIMAL_CONFIG: CliConfig = {
  seedPrompt: 'You are a helpful assistant.',
  testSet: [
    { prompt: 'What is 2+2?' },
  ],
};

const FULL_CONFIG: CliConfig = {
  name: 'Test Evolution',
  seedPrompt: 'You are a helpful assistant.',
  testSet: [
    { id: 'test-1', name: 'Math', mode: 'exact_match', prompt: 'What is 2+2?', expected: '4' },
    { id: 'test-2', name: 'Reasoning', mode: 'llm_grade', prompt: 'Explain gravity.' },
  ],
  models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'],
  serviceModel: 'openai/gpt-4o-mini',
  populationSize: 8,
  generationSize: 8,
  maxGenerations: 5,
  budget: 5.00,
  parallelLimit: 3,
  fitnessWeights: { quality: 0.7, cost: 0.3 },
  openrouterKey: 'sk-or-test-key',
  openaiKey: 'sk-test-openai',
};

describe('CLI Config - validateCliConfig', () => {
  it('accepts minimal valid config', () => {
    expect(() => validateCliConfig(MINIMAL_CONFIG)).not.toThrow();
  });

  it('accepts full config', () => {
    expect(() => validateCliConfig(FULL_CONFIG)).not.toThrow();
  });

  it('rejects config without seedPrompt or initialPrompts', () => {
    expect(() => validateCliConfig({ testSet: [{ prompt: 'x' }] } as any)).toThrow('seedPrompt');
  });

  it('rejects config without testSet', () => {
    expect(() => validateCliConfig({ seedPrompt: 'x' } as any)).toThrow('testSet');
  });

  it('rejects empty testSet', () => {
    expect(() => validateCliConfig({ seedPrompt: 'x', testSet: [] })).toThrow('testSet');
  });

  it('rejects test without prompt', () => {
    expect(() => validateCliConfig({ seedPrompt: 'x', testSet: [{}] } as any)).toThrow('testSet[0]');
  });

  it('rejects invalid model format', () => {
    expect(() => validateCliConfig({
      seedPrompt: 'x',
      testSet: [{ prompt: 'y' }],
      models: ['invalid-no-slash'],
    })).toThrow('Expected "provider/model"');
  });

  it('rejects unknown provider', () => {
    expect(() => validateCliConfig({
      seedPrompt: 'x',
      testSet: [{ prompt: 'y' }],
      models: ['unknown/model'],
    })).toThrow('Unknown provider');
  });
});

describe('CLI Config - validateCliConfig (initialPrompts)', () => {
  it('accepts config with initialPrompts and no seedPrompt', () => {
    expect(() => validateCliConfig({
      initialPrompts: ['Prompt A', 'Prompt B'],
      testSet: [{ prompt: 'x' }],
    } as any)).not.toThrow();
  });

  it('rejects empty initialPrompts array', () => {
    expect(() => validateCliConfig({
      initialPrompts: [],
      testSet: [{ prompt: 'x' }],
    } as any)).toThrow('non-empty array');
  });

  it('rejects initialPrompts with empty string entry', () => {
    expect(() => validateCliConfig({
      initialPrompts: ['Valid', ''],
      testSet: [{ prompt: 'x' }],
    } as any)).toThrow('initialPrompts[1]');
  });

  it('accepts config with both seedPrompt and initialPrompts', () => {
    expect(() => validateCliConfig({
      seedPrompt: 'seed',
      initialPrompts: ['Prompt A'],
      testSet: [{ prompt: 'x' }],
    } as any)).not.toThrow();
  });
});

describe('CLI Config - toEvaluationConfig', () => {
  it('maps minimal config with defaults', () => {
    const evalConfig = toEvaluationConfig(MINIMAL_CONFIG);

    expect(evalConfig.name).toBe('CLI Evolution');
    expect(evalConfig.population.seedPrompt).toBe('You are a helpful assistant.');
    expect(evalConfig.population.initialSize).toBe(6);
    expect(evalConfig.targets.maxGenerations).toBe(3);
    expect(evalConfig.parallelLimit).toBe(5);
    expect(evalConfig.serviceModelMaxTokens).toBe(20000);
    expect(evalConfig.retries).toBe(3);
    expect(evalConfig.enabledModels).toHaveLength(1);
    expect(evalConfig.enabledModels[0]).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(evalConfig.serviceModel).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(evalConfig.fitness.weights.quality).toBe(1.0);
    expect(evalConfig.selection.policy).toBe('topk');
    expect(evalConfig.selection.topK).toBe(3);
    expect(evalConfig.testSet).toHaveLength(1);
    expect(evalConfig.testSet[0].mode).toBe('llm_grade');
    expect(evalConfig.testSet[0].id).toBeDefined();
    expect(evalConfig.id).toBeDefined();
  });

  it('maps full config correctly', () => {
    const evalConfig = toEvaluationConfig(FULL_CONFIG);

    expect(evalConfig.name).toBe('Test Evolution');
    expect(evalConfig.population.initialSize).toBe(8);
    expect(evalConfig.population.generationSize).toBe(8);
    expect(evalConfig.targets.maxGenerations).toBe(5);
    expect(evalConfig.targets.budgetUSD).toBe(5.00);
    expect(evalConfig.parallelLimit).toBe(3);
    expect(evalConfig.enabledModels).toHaveLength(2);
    expect(evalConfig.enabledModels[0]).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(evalConfig.enabledModels[1]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4.5' });
    expect(evalConfig.serviceModel).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(evalConfig.fitness.weights.quality).toBe(0.7);
    expect(evalConfig.fitness.weights.cost).toBe(0.3);
    expect(evalConfig.testSet).toHaveLength(2);
    expect(evalConfig.testSet[0].mode).toBe('exact_match');
    expect(evalConfig.testSet[0].expected).toBe('4');
  });

  it('uses first enabled model as service model when not specified', () => {
    const config: CliConfig = {
      seedPrompt: 'test',
      testSet: [{ prompt: 'x' }],
      models: ['anthropic/claude-sonnet-4.5'],
    };
    const evalConfig = toEvaluationConfig(config);
    expect(evalConfig.serviceModel).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4.5' });
  });

  it('generationSize defaults to populationSize', () => {
    const config: CliConfig = {
      seedPrompt: 'test',
      testSet: [{ prompt: 'x' }],
      populationSize: 10,
    };
    const evalConfig = toEvaluationConfig(config);
    expect(evalConfig.population.initialSize).toBe(10);
    expect(evalConfig.population.generationSize).toBe(10);
  });
});

describe('CLI Config - toEvaluationConfig (initialPrompts)', () => {
  it('produces fill:"manual" with correct manualPrompts', () => {
    const config: CliConfig = {
      initialPrompts: ['Prompt A', 'Prompt B', 'Prompt C'],
      testSet: [{ prompt: 'x' }],
      models: ['openai/gpt-4o'],
    };
    const evalConfig = toEvaluationConfig(config);

    expect(evalConfig.population.fill).toBe('manual');
    expect(evalConfig.population.initialSize).toBe(3);
    const manualPrompts = (evalConfig.population as any).manualPrompts;
    expect(manualPrompts).toHaveLength(3);
    expect(manualPrompts[0].prompt).toBe('Prompt A');
    expect(manualPrompts[1].prompt).toBe('Prompt B');
    expect(manualPrompts[2].prompt).toBe('Prompt C');
  });

  it('defaults seedPrompt to first initialPrompt when seedPrompt is absent', () => {
    const config: CliConfig = {
      initialPrompts: ['First prompt', 'Second prompt'],
      testSet: [{ prompt: 'x' }],
    };
    const evalConfig = toEvaluationConfig(config);

    expect(evalConfig.population.seedPrompt).toBe('First prompt');
  });

  it('uses explicit seedPrompt when both seedPrompt and initialPrompts are provided', () => {
    const config: CliConfig = {
      seedPrompt: 'Explicit seed',
      initialPrompts: ['Prompt A', 'Prompt B'],
      testSet: [{ prompt: 'x' }],
    };
    const evalConfig = toEvaluationConfig(config);

    expect(evalConfig.population.seedPrompt).toBe('Explicit seed');
    expect(evalConfig.population.fill).toBe('manual');
  });

  it('assigns models via round-robin across initialPrompts', () => {
    const config: CliConfig = {
      initialPrompts: ['A', 'B', 'C', 'D', 'E'],
      testSet: [{ prompt: 'x' }],
      models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'],
    };
    const evalConfig = toEvaluationConfig(config);
    const manualPrompts = (evalConfig.population as any).manualPrompts;

    expect(manualPrompts[0].model).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(manualPrompts[1].model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4.5' });
    expect(manualPrompts[2].model).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(manualPrompts[3].model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4.5' });
    expect(manualPrompts[4].model).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('ignores populationSize when initialPrompts is provided', () => {
    const config: CliConfig = {
      initialPrompts: ['A', 'B'],
      testSet: [{ prompt: 'x' }],
      populationSize: 10,
    };
    const evalConfig = toEvaluationConfig(config);

    expect(evalConfig.population.initialSize).toBe(2);
  });

  it('still uses auto fill when initialPrompts is not provided', () => {
    const config: CliConfig = {
      seedPrompt: 'test',
      testSet: [{ prompt: 'x' }],
    };
    const evalConfig = toEvaluationConfig(config);

    expect(evalConfig.population.fill).toBe('auto');
    expect((evalConfig.population as any).manualPrompts).toBeUndefined();
  });
});

describe('CLI Config - extractConfigKeys', () => {
  it('extracts inline API keys', () => {
    const keys = extractConfigKeys(FULL_CONFIG);
    expect(keys.openrouterKey).toBe('sk-or-test-key');
    expect(keys.openaiKey).toBe('sk-test-openai');
    expect(keys.anthropicKey).toBeUndefined();
  });

  it('returns empty object for config without keys', () => {
    const keys = extractConfigKeys(MINIMAL_CONFIG);
    expect(Object.keys(keys)).toHaveLength(0);
  });
});

describe('CLI Config - loadCliConfig', () => {
  const tmpDir = path.join(process.cwd(), 'tests', 'unit', 'cli', '.tmp');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid JSON file', () => {
    const configPath = path.join(tmpDir, 'test.json');
    fs.writeFileSync(configPath, JSON.stringify(MINIMAL_CONFIG));

    const config = loadCliConfig(configPath);
    expect(config.seedPrompt).toBe('You are a helpful assistant.');
  });

  it('throws for non-existent file', () => {
    expect(() => loadCliConfig('/nonexistent/path.json')).toThrow('not found');
  });

  it('throws for invalid JSON', () => {
    const configPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(configPath, 'not json{');

    expect(() => loadCliConfig(configPath)).toThrow('Invalid JSON');
  });

  it('throws for JSON that fails validation', () => {
    const configPath = path.join(tmpDir, 'invalid.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'no seedPrompt' }));

    expect(() => loadCliConfig(configPath)).toThrow('seedPrompt');
  });
});
