import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mutateNode } from '../../src/engine/mutations';
import type { EvaluationConfig } from '../../../src/types';

// Mock the provider factory
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: vi.fn(),
}));

import { getProviderAdapter } from '../../src/providers/index.js';

function makeConfig(over: Partial<EvaluationConfig> = {}): EvaluationConfig {
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
    ...over,
  };
}

function mockAdapter(responses: Array<{ output: string; promptTokens: number; completionTokens: number; usd: number; latencyMs: number }>) {
  let callIndex = 0;
  const callFn = vi.fn().mockImplementation(async () => {
    if (callIndex < responses.length) {
      return responses[callIndex++];
    }
    throw new Error('No more mock responses');
  });
  (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });
  return callFn;
}

describe('mutateNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mutated prompt with changelog and cost tracking', async () => {
    const proposalResponse = {
      output: JSON.stringify([
        { label: 'MUTATION', edit: '[Structure] Reorder sections for clarity' },
      ]),
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    };
    const applyResponse = {
      output: 'Improved prompt with better structure',
      promptTokens: 80,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 150,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await mutateNode('Original prompt', makeConfig());

    expect(result.prompt).toBe('Improved prompt with better structure');
    expect(result.changeLog.length).toBeGreaterThan(0);
    expect(result.changeLog[0].label).toBe('MUTATION');
    expect(result.cost.calls).toBe(2);
    expect(result.cost.promptTokens).toBe(180);
    expect(result.cost.completionTokens).toBe(110);
    expect(result.cost.usd).toBeCloseTo(0.003);
  });

  it('handles markdown-wrapped JSON in proposal response', async () => {
    const proposalResponse = {
      output: '```json\n[{"label":"MUTATION","edit":"Add examples"}]\n```',
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    };
    const applyResponse = {
      output: 'Prompt with examples added',
      promptTokens: 80,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 150,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await mutateNode('Original prompt', makeConfig());
    expect(result.prompt).toBe('Prompt with examples added');
    expect(result.changeLog.length).toBeGreaterThan(0);
  });

  it('tracks cost across multiple edits', async () => {
    const proposalResponse = {
      output: JSON.stringify([
        { label: 'MUTATION', edit: 'Edit 1' },
        { label: 'MUTATION', edit: 'Edit 2' },
        { label: 'MUTATION', edit: 'Edit 3' },
      ]),
      promptTokens: 100,
      completionTokens: 80,
      usd: 0.002,
      latencyMs: 300,
    };
    const applyResponse = {
      output: 'Triply improved prompt',
      promptTokens: 120,
      completionTokens: 90,
      usd: 0.003,
      latencyMs: 200,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await mutateNode('Base prompt', makeConfig());
    expect(result.changeLog).toHaveLength(3);
    expect(result.cost.calls).toBe(2);
  });

  it('retries on JSON parse failure in proposal step', async () => {
    const badResponse = {
      output: 'not valid json at all',
      promptTokens: 50,
      completionTokens: 30,
      usd: 0.0005,
      latencyMs: 100,
    };
    const goodProposal = {
      output: JSON.stringify([{ label: 'MUTATION', edit: 'Fix something' }]),
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    };
    const applyResponse = {
      output: 'Fixed prompt',
      promptTokens: 80,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 150,
    };
    mockAdapter([badResponse, goodProposal, applyResponse]);

    const result = await mutateNode('Original', makeConfig());
    expect(result.prompt).toBe('Fixed prompt');
    // Cost should include the failed attempt
    expect(result.cost.calls).toBeGreaterThanOrEqual(2);
  });

  it('throws after exhausting retries on persistent parse failure', async () => {
    const badResponse = {
      output: 'not json',
      promptTokens: 50,
      completionTokens: 30,
      usd: 0.0005,
      latencyMs: 100,
    };
    // Create enough bad responses to exhaust retries
    const responses = Array(10).fill(badResponse);
    mockAdapter(responses);

    await expect(mutateNode('Original', makeConfig())).rejects.toThrow();
  });

  it('throws on empty proposal response', async () => {
    const emptyResponse = {
      output: '',
      promptTokens: 50,
      completionTokens: 0,
      usd: 0.0005,
      latencyMs: 100,
    };
    mockAdapter([emptyResponse]);

    await expect(mutateNode('Original', makeConfig())).rejects.toThrow();
  });
});

/**
 * Open-bugs 2026-07-31 #1/#2: the apply step's output was adopted with no
 * validation at all. A no-op came back with a changelog claiming two applied
 * mutations; an instruction echo and the proposal JSON itself were evaluated
 * as candidate prompts (one became a champion).
 */
describe('mutateNode validates the APPLIED prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const usage = { promptTokens: 100, completionTokens: 50, usd: 0.001, latencyMs: 100 };
  const proposal = {
    ...usage,
    output: JSON.stringify([
      { label: 'MUTATION', edit: '[Rewrite] Rewrite the role/identity statement to better align with the actual task requirements' },
    ]),
  };

  it('retries the apply step when the model echoes the proposal JSON, then adopts the rewrite', async () => {
    const calls = mockAdapter([
      proposal,
      { ...usage, output: '[{"label":"MUTATION","edit":"append the token ALPHA"}]' },
      { ...usage, output: 'You are a precise task assistant. Answer directly.' },
    ]);

    const result = await mutateNode('Answer the question.', makeConfig());
    expect(result.prompt).toBe('You are a precise task assistant. Answer directly.');
    expect(result.changeLog[0].label).toBe('MUTATION');
    // The rejected attempt was billed and must be accounted.
    expect(result.cost.calls).toBe(3);
    // The retry told the model WHY the previous reply was unusable.
    const retryPrompt = calls.mock.calls[2][0].prompt as string;
    expect(retryPrompt).toMatch(/rejected/i);
  });

  it('carries the parent with an honest changelog when the model keeps echoing the instruction', async () => {
    const echo = {
      ...usage,
      output: 'Rewrite the role/identity statement to better align with the actual task requirements: You…',
    };
    mockAdapter([proposal, echo, echo]);

    const result = await mutateNode('Answer the question.', makeConfig({ retries: 2 }));
    expect(result.prompt).toBe('Answer the question.');
    // NOT a fabricated list of applied mutations — the observed changelog lie.
    expect(result.changeLog).toHaveLength(1);
    expect(result.changeLog[0].label).toBe('CARRY');
    expect(result.changeLog[0].text).toMatch(/instruction/i);
    expect(result.cost.calls).toBe(3);
  });

  it('carries the parent when the applied prompt comes back identical (paid no-op)', async () => {
    const noop = { ...usage, output: 'Answer the question.' };
    mockAdapter([proposal, noop, noop]);

    const result = await mutateNode('Answer the question.', makeConfig({ retries: 2 }));
    expect(result.prompt).toBe('Answer the question.');
    expect(result.changeLog).toHaveLength(1);
    expect(result.changeLog[0].label).toBe('CARRY');
    expect(result.changeLog[0].text).toMatch(/identical/i);
    // Both apply attempts plus the proposal were billed.
    expect(result.cost.calls).toBe(3);
  });

  it('adopts a rewrite that passes on the second apply attempt after a no-op', async () => {
    mockAdapter([
      proposal,
      { ...usage, output: 'Answer the question.' },
      { ...usage, output: 'You are the task-focused assistant. Answer the question directly.' },
    ]);

    const result = await mutateNode('Answer the question.', makeConfig());
    expect(result.prompt).toBe('You are the task-focused assistant. Answer the question directly.');
    expect(result.changeLog[0].label).toBe('MUTATION');
  });
});
