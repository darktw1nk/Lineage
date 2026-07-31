import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metaPromptNode } from '../../src/engine/metaprompting';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

// Mock the provider factory
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: vi.fn(),
}));

import { getProviderAdapter } from '../../src/providers/index.js';

function makeNode(id: string, prompt: string, tests?: any[]): CandidateNode {
  return {
    id,
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt,
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
    tests,
    metrics: { quality: 7, fitness: 7 },
  };
}

function makeConfig(): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 4 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0.3,
      metaPrompting: { enabled: true, share: 0.2 },
    },
    population: { initialSize: 10, generationSize: 10, seedPrompt: 'test', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-4' }],
    testSet: [
      { id: 't1', name: 'Test 1', mode: 'llm_grade', prompt: 'test prompt 1' },
      { id: 't2', name: 'Test 2', mode: 'llm_grade', prompt: 'test prompt 2' },
    ],
    fitness: { weights: { quality: 1.0 } },
    targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    serviceModelMaxTokens: 20000,
    retries: 3,
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

describe('metaPromptNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns improved prompt with META changelog', async () => {
    const proposalResponse = {
      output: JSON.stringify([
        { label: 'META', edit: 'Add error handling instructions' },
      ]),
      promptTokens: 120,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 250,
    };
    const applyResponse = {
      output: 'Improved prompt with error handling',
      promptTokens: 100,
      completionTokens: 70,
      usd: 0.002,
      latencyMs: 200,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const parent = makeNode('parent-1', 'Base prompt');
    const generation = [parent];
    const result = await metaPromptNode(parent, makeConfig(), generation);

    expect(result.prompt).toBe('Improved prompt with error handling');
    expect(result.changeLog.length).toBeGreaterThan(0);
    expect(result.changeLog[0].label).toBe('META');
    expect(result.cost.calls).toBe(2);
  });

  it('handles generation with failed tests (failure-aware mode)', async () => {
    const failedNode = makeNode('failed-1', 'Failing prompt', [
      { testId: 't1', passed: false, score: 2, promptTokens: 10, completionTokens: 10, latencyMs: 100, outputText: 'Wrong output' },
      { testId: 't2', passed: true, score: 8, promptTokens: 10, completionTokens: 10, latencyMs: 100 },
    ]);
    const proposalResponse = {
      output: JSON.stringify([
        { label: 'META', edit: 'Fix test failure by adding constraints' },
      ]),
      promptTokens: 150,
      completionTokens: 70,
      usd: 0.003,
      latencyMs: 300,
    };
    const applyResponse = {
      output: 'Fixed prompt addressing test failures',
      promptTokens: 100,
      completionTokens: 80,
      usd: 0.002,
      latencyMs: 200,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await metaPromptNode(failedNode, makeConfig(), [failedNode]);
    expect(result.prompt).toBe('Fixed prompt addressing test failures');
  });

  it('tracks cost from both proposal and apply steps', async () => {
    const proposalResponse = {
      output: JSON.stringify([{ label: 'META', edit: 'Improve clarity' }]),
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    };
    const applyResponse = {
      output: 'Clearer prompt',
      promptTokens: 80,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 150,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await metaPromptNode(makeNode('p', 'prompt'), makeConfig(), []);
    expect(result.cost.promptTokens).toBe(180);
    expect(result.cost.completionTokens).toBe(110);
    expect(result.cost.usd).toBeCloseTo(0.003);
    expect(result.cost.calls).toBe(2);
  });

  it('handles markdown-wrapped JSON in proposal', async () => {
    const proposalResponse = {
      output: '```json\n[{"label":"META","edit":"Refinement"}]\n```',
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    };
    const applyResponse = {
      output: 'Refined prompt',
      promptTokens: 80,
      completionTokens: 60,
      usd: 0.002,
      latencyMs: 150,
    };
    mockAdapter([proposalResponse, applyResponse]);

    const result = await metaPromptNode(makeNode('p', 'prompt'), makeConfig(), []);
    expect(result.prompt).toBe('Refined prompt');
  });

  it('throws on empty proposal response', async () => {
    mockAdapter([{
      output: '',
      promptTokens: 50,
      completionTokens: 0,
      usd: 0.0005,
      latencyMs: 100,
    }]);

    await expect(
      metaPromptNode(makeNode('p', 'prompt'), makeConfig(), [])
    ).rejects.toThrow();
  });

  it('throws on unparseable proposal JSON', async () => {
    mockAdapter([{
      output: 'this is not json at all',
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.001,
      latencyMs: 200,
    }]);

    await expect(
      metaPromptNode(makeNode('p', 'prompt'), makeConfig(), [])
    ).rejects.toThrow();
  });
});

/** Open-bugs 2026-07-31 #1/#2: the applied output was adopted with no validation. */
describe('metaPromptNode validates the applied prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const usage = { promptTokens: 100, completionTokens: 50, usd: 0.001, latencyMs: 100 };
  const proposal = {
    ...usage,
    output: JSON.stringify([{ label: 'META', edit: 'Add explicit output format rules to the prompt' }]),
  };
  const PARENT = 'Summarize the meeting notes into action items.';

  it('retries the apply step when the edits JSON is echoed back, then adopts the rewrite', async () => {
    mockAdapter([
      proposal,
      { ...usage, output: '[{"label":"META","edit":"Add explicit output format rules to the prompt"}]' },
      { ...usage, output: 'Summarize the meeting notes into action items. Output one bullet per item.' },
    ]);

    const result = await metaPromptNode(makeNode('p', PARENT), makeConfig(), []);
    expect(result.prompt).toBe('Summarize the meeting notes into action items. Output one bullet per item.');
    expect(result.changeLog[0].label).toBe('META');
    expect(result.cost.calls).toBe(3);
  });

  it('carries the parent under a CARRY line when the apply keeps returning it unchanged', async () => {
    const noop = { ...usage, output: PARENT };
    mockAdapter([proposal, noop, noop, noop]);

    const result = await metaPromptNode(makeNode('p', PARENT), makeConfig(), []);
    expect(result.prompt).toBe(PARENT);
    expect(result.changeLog).toHaveLength(1);
    expect(result.changeLog[0].label).toBe('CARRY');
    expect(result.changeLog[0].text).toMatch(/identical/i);
    expect(result.cost.calls).toBe(4);
  });
});
