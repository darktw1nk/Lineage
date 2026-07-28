import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
// Mutation/crossover/meta call LLMs — stub the provider factory so built-ins
// selected by leftover shares can't make network calls in this test.
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai',
    estimateTokens: () => ({ prompt: 1 }),
    call: async () => ({ output: 'stub', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
  }),
}));

import { createNextGeneration } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry } from '../../src/registry.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

function makeParent(id: string, fitness = 5): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished',
    prompt: `prompt-${id}`,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  } as CandidateNode;
}

function makeConfig(custom: NonNullable<EvaluationConfig['operators']['custom']>): EvaluationConfig {
  return {
    id: 'c1', name: 'dispatch test',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 0, crossoverShare: 0, custom },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  } as EvaluationConfig;
}

function run(parents: CandidateNode[], config: EvaluationConfig) {
  return createNextGeneration(parents, parents, 1, config, [parents]);
}

beforeEach(() => resetRegistry());

describe('plugin operator dispatch', () => {
  it('routes children through a registered plugin operator', async () => {
    const seen: string[] = [];
    registerOperator({
      name: 'upper', parents: 1,
      apply: async ({ parent }) => {
        seen.push(parent.id);
        return {
          prompt: parent.prompt.toUpperCase(),
          changeLog: [{ label: 'UPPER', text: 'uppercased' }],
          cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 1 },
        };
      },
    });

    const parents = [makeParent('p1'), makeParent('p2')];
    const { newNodes, costTracking } = await run(parents, makeConfig({ upper: { share: 1 } }));

    const children = newNodes.filter(n => (n as any)._operatorType === 'upper');
    expect(children.length).toBeGreaterThan(0);
    expect(children[0].prompt).toBe(children[0].prompt.toUpperCase());
    expect(children[0].changeLog[0].label).toBe('UPPER');
    expect(seen.length).toBe(children.length);
    expect(costTracking.calls).toBe(children.length);
  });

  it('binary plugin operators receive parentB and record both lineage parents', async () => {
    registerOperator({
      name: 'merge2', parents: 2,
      apply: async ({ parent, parentB }) => ({
        prompt: parent.prompt + '+' + parentB!.prompt,
        changeLog: [{ label: 'MERGE2', text: 'merged' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });

    const parents = [makeParent('p1'), makeParent('p2')];
    const { newNodes } = await run(parents, makeConfig({ merge2: { share: 1 } }));
    const merged = newNodes.find(n => (n as any)._operatorType === 'merge2')!;
    expect(merged.lineageParents.length).toBe(2);
  });

  it('applies params patches from plugin results', async () => {
    registerOperator({
      name: 'heat', parents: 1,
      apply: async ({ parent }) => ({
        prompt: parent.prompt,
        params: { temperature: 1.5 },
        changeLog: [{ label: 'HEAT', text: 'temp up' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });
    const parents = [makeParent('p1')];
    const { newNodes } = await run(parents, makeConfig({ heat: { share: 1 } }));
    const child = newNodes.find(n => (n as any)._operatorType === 'heat')!;
    expect(child.params.temperature).toBe(1.5);
  });

  it('a throwing plugin falls back to carry-forward with ERROR changelog', async () => {
    registerOperator({
      name: 'boom', parents: 1,
      apply: async () => { throw new Error('kaput'); },
    });
    const parents = [makeParent('p1')];
    const { newNodes } = await run(parents, makeConfig({ boom: { share: 1 } }));
    const carried = newNodes.filter(n => n.changeLog.some(c => c.label === 'ERROR'));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried[0].prompt).toBe('prompt-p1');
  });

  it('ignores unknown custom operator names with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parents = [makeParent('p1')];
    const config = makeConfig({ ghost: { share: 1 } });
    config.operators.mutationShare = 0; // total known share is 0 → carry path
    const { newNodes } = await run(parents, config);
    expect(newNodes.length).toBeGreaterThan(0); // carry-forward population still produced
    expect(warn.mock.calls.some(c => String(c[0]).includes('ghost'))).toBe(true);
    warn.mockRestore();
  });

  it('custom entries override legacy fields for the same built-in name', async () => {
    const parents = [makeParent('p1')];
    const config = makeConfig({ mutation: { enabled: false, share: 0 }, upper2: { share: 1 } });
    config.operators.mutationShare = 1; // legacy says mutation share 1 — custom disables it
    registerOperator({
      name: 'upper2', parents: 1,
      apply: async ({ parent }) => ({
        prompt: parent.prompt.toUpperCase(),
        changeLog: [{ label: 'UPPER2', text: 'x' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });
    const { newNodes } = await run(parents, config);
    expect(newNodes.some(n => (n as any)._operatorType === 'mutation')).toBe(false);
    expect(newNodes.some(n => (n as any)._operatorType === 'upper2')).toBe(true);
  });
});
