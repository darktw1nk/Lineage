import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crossoverNodes } from '../../src/engine/crossover';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

// Mock the provider factory
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: vi.fn(),
}));

import { getProviderAdapter } from '../../src/providers/index.js';

function makeNode(id: string, prompt: string): CandidateNode {
  return {
    id,
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt,
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
  };
}

function makeConfig(): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
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

describe('crossoverNodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns merged prompt with crossover changelog', async () => {
    const callFn = vi.fn().mockResolvedValue({
      output: 'Merged prompt combining best of A and B',
      promptTokens: 150,
      completionTokens: 80,
      usd: 0.003,
      latencyMs: 300,
    });
    (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });

    const parentA = makeNode('aaaa-1111', 'Prompt A text');
    const parentB = makeNode('bbbb-2222', 'Prompt B text');
    const result = await crossoverNodes(parentA, parentB, makeConfig());

    expect(result.prompt).toBe('Merged prompt combining best of A and B');
    expect(result.changeLog).toHaveLength(1);
    expect(result.changeLog[0].label).toBe('CROSSOVER');
    expect(result.changeLog[0].text).toContain('aaaa-111');
    expect(result.changeLog[0].text).toContain('bbbb-222');
  });

  it('makes exactly one LLM call', async () => {
    const callFn = vi.fn().mockResolvedValue({
      output: 'Merged result',
      promptTokens: 100,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 200,
    });
    (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });

    const parentA = makeNode('a', 'A');
    const parentB = makeNode('b', 'B');
    await crossoverNodes(parentA, parentB, makeConfig());

    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('tracks cost correctly', async () => {
    const callFn = vi.fn().mockResolvedValue({
      output: 'Result',
      promptTokens: 200,
      completionTokens: 100,
      usd: 0.005,
      latencyMs: 250,
    });
    (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });

    const result = await crossoverNodes(makeNode('a', 'A'), makeNode('b', 'B'), makeConfig());

    expect(result.cost.promptTokens).toBe(200);
    expect(result.cost.completionTokens).toBe(100);
    expect(result.cost.usd).toBe(0.005);
    expect(result.cost.calls).toBe(1);
  });

  it('uses temperature 0.7 for crossover call', async () => {
    const callFn = vi.fn().mockResolvedValue({
      output: 'Result',
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    });
    (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });

    await crossoverNodes(makeNode('a', 'A'), makeNode('b', 'B'), makeConfig());

    expect(callFn).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7 })
    );
  });

  it('throws on empty response', async () => {
    const callFn = vi.fn().mockResolvedValue({
      output: '',
      promptTokens: 100,
      completionTokens: 0,
      usd: 0.001,
      latencyMs: 200,
    });
    (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });

    await expect(
      crossoverNodes(makeNode('a', 'A'), makeNode('b', 'B'), makeConfig())
    ).rejects.toThrow();
  });
});
