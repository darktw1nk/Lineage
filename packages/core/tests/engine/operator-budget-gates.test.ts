import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: vi.fn(),
}));

import { getProviderAdapter } from '../../src/providers/index.js';
import { mutateNode } from '../../src/engine/mutations.js';
import { crossoverNodes } from '../../src/engine/crossover.js';
import { createNextGeneration } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry, getOperator } from '../../src/registry.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * Pass 19, hunter B findings F1/F2. Budget enforcement is a settled-spend
 * check that ran ONCE per operator/child, and pass 18's retry loops multiplied
 * the billing window behind it: measured 2×retries calls per mutation (160x a
 * tight cap at defaults) and a whole generation's ceilings after the gate
 * froze at transition start (4.6x).
 *
 * The fix is two-sided: operators receive `shouldAbort(spentSoFarUSD)` and
 * check it between their own billed calls, and createNextGeneration settles
 * each child's spend via `budget.accrueChild` the moment the child completes,
 * so the NEXT child's gate sees it.
 */
const usage = { promptTokens: 100, completionTokens: 50, usd: 0.001, latencyMs: 50 };

function makeConfig(over: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    id: 'bg-cfg', name: 'budget gates',
    selection: { policy: 'topk', topK: 4 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 1, serviceModelMaxTokens: 100, retries: 3,
    ...over,
  } as EvaluationConfig;
}

function mockAdapter(outputs: string[]) {
  let i = 0;
  const callFn = vi.fn().mockImplementation(async () => {
    if (i >= outputs.length) throw new Error('No more mock responses');
    return { ...usage, output: outputs[i++] };
  });
  (getProviderAdapter as any).mockReturnValue({ call: callFn, name: 'openai' });
  return callFn;
}

const PROPOSAL = JSON.stringify([{ label: 'MUTATION', edit: 'Rewrite the opening statement of the prompt entirely' }]);
const REJECTED_APPLY = '[{"label":"MUTATION","edit":"echoed edit list, not a prompt"}]';

beforeEach(() => {
  vi.clearAllMocks();
  resetRegistry();
});

describe('operators stop retrying once the budget is gone', () => {
  it('mutateNode aborts the apply retries and carries, instead of billing the full ceiling', async () => {
    const calls = mockAdapter([PROPOSAL, REJECTED_APPLY, REJECTED_APPLY, REJECTED_APPLY]);
    // Cap trips once this operator's own unsettled spend reaches $0.0015 —
    // i.e. after the proposal ($0.001) plus one apply attempt ($0.001).
    const result = await mutateNode('Answer the question.', makeConfig(), Math.random,
      (spent = 0) => spent >= 0.0015);

    expect(result.changeLog[0].label).toBe('CARRY');
    expect(result.changeLog[0].text).toMatch(/budget exhausted/i);
    expect(result.prompt).toBe('Answer the question.');
    // Proposal + ONE apply attempt — not proposal + retries applies.
    expect(calls).toHaveBeenCalledTimes(2);
    expect(result.cost.calls).toBe(2);
  });

  it('crossoverNodes aborts mid-retry and carries parent A with the spend accounted', async () => {
    const calls = mockAdapter(['{"merged": true}', '{"merged": true}', '{"merged": true}']);
    const A = { id: 'aaaa', prompt: 'Prompt A', params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 }, changeLog: [], lineageParents: [], generation: 0, status: 'finished' } as unknown as CandidateNode;
    const B = { ...A, id: 'bbbb', prompt: 'Prompt B' } as CandidateNode;

    const result = await crossoverNodes(A, B, makeConfig(), (spent = 0) => spent >= 0.0005);
    expect(result.prompt).toBe('Prompt A');
    expect(result.changeLog[0].label).toBe('CARRY');
    expect(result.changeLog[0].text).toMatch(/budget exhausted/i);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(result.cost.calls).toBe(1);
  });
});

describe('the REGISTRY forwards shouldAbort to the built-in operators (pass 20, F8/F9)', () => {
  // Reverting the registry's forwarding (or the operator's own check) left the
  // whole suite green in pass 20's revert-check — the only wiring that gives
  // real runs the mid-operator budget gate was unguarded. These drive the
  // operators THROUGH getOperator(...).apply, exactly as createChild does.
  const parent = {
    id: 'p1', generation: 0, lineageParents: [], status: 'finished',
    prompt: 'Answer the question.', changeLog: [],
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    metrics: { fitness: 5, quality: 5 },
  } as unknown as CandidateNode;
  const parentB = { ...parent, id: 'p2', prompt: 'Cite sources always.' } as CandidateNode;

  it('mutation aborts through the registry after the cap trips', async () => {
    const calls = mockAdapter([PROPOSAL, REJECTED_APPLY, REJECTED_APPLY, REJECTED_APPLY]);
    const r = await getOperator('mutation')!.apply({
      parent, config: makeConfig(), generation: [], rng: Math.random,
      shouldAbort: (spent = 0) => spent >= 0.0015,
    } as any);
    expect(r.changeLog[0].label).toBe('CARRY');
    expect(r.changeLog[0].text).toMatch(/budget exhausted/i);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('meta aborts through the registry after the proposal spend alone', async () => {
    const calls = mockAdapter([
      JSON.stringify([{ label: 'META', edit: 'Add explicit output format rules to the prompt text' }]),
      'unused apply reply',
    ]);
    const r = await getOperator('meta')!.apply({
      parent, config: makeConfig(), generation: [],
      shouldAbort: (spent = 0) => spent >= 0.0005,
    } as any);
    expect(r.changeLog[0].label).toBe('CARRY');
    expect(r.changeLog[0].text).toMatch(/budget exhausted/i);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('crossover aborts through the registry mid-retry', async () => {
    const calls = mockAdapter(['{"merged": true}', '{"merged": true}', '{"merged": true}']);
    const r = await getOperator('crossover')!.apply({
      parent, parentB, config: makeConfig(), generation: [],
      shouldAbort: (spent = 0) => spent >= 0.0005,
    } as any);
    expect(r.changeLog[0].label).toBe('CARRY');
    expect(r.changeLog[0].text).toMatch(/budget exhausted/i);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe('a generation transition settles spend per child, not per batch', () => {
  function makeParent(id: string): CandidateNode {
    return {
      id, generation: 0, lineageParents: [], status: 'finished', prompt: `prompt-${id}`,
      params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
      changeLog: [], metrics: { fitness: 5, quality: 5 },
    } as CandidateNode;
  }

  it('later children see earlier children\'s spend and carry unpaid', async () => {
    let applies = 0;
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        applies++;
        return {
          prompt: `child-${applies}`, changeLog: [{ label: 'MUTATION', text: 'x' }],
          cost: { promptTokens: 1, completionTokens: 1, usd: 0.01, calls: 1 },
        };
      },
    } as any);

    // Cap $0.015: child 1 settles $0.01, child 2 runs ($0.02 settled), the
    // gate then reads the accrued total and children 3-4 must carry unpaid.
    let settled = 0;
    const budget = {
      reserve: async () => 0,
      release: () => {},
      exhausted: (extra = 0) => settled + extra >= 0.015,
      accrueChild: (cost: any) => { settled += cost.usd; },
    };
    const parents = [makeParent('p1'), makeParent('p2')];
    const config = makeConfig({ operators: { mutationShare: 0, crossoverShare: 0, custom: { probe: { share: 1 } } } as any });
    const { newNodes, costTracking } = await createNextGeneration(parents, parents, 1, config, [parents], budget);

    // The pre-fix behavior ran ALL 4 children (the gate read a frozen total).
    expect(applies).toBe(2);
    expect(settled).toBeCloseTo(0.02, 10);
    expect(costTracking.usd).toBeCloseTo(0.02, 10);
    const carried = newNodes.filter(n => n.changeLog[0]?.text?.match(/budget exhausted/i));
    expect(carried.length).toBe(2);
  });
});

describe('pass-20 hunter-B holes: what an operator reports cannot corrupt the books', () => {
  function makeParent(id: string): CandidateNode {
    return {
      id, generation: 0, lineageParents: [], status: 'finished', prompt: `prompt-${id}`,
      params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
      changeLog: [], metrics: { fitness: 5, quality: 5 },
    } as CandidateNode;
  }
  const custom = { operators: { mutationShare: 0, crossoverShare: 0, custom: { probe: { share: 1 } } } as any };

  it('NEGATIVE operator cost is clamped, never accrued (F1: totals rewound to -$35.60)', async () => {
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => ({
        prompt: 'a different child prompt', changeLog: [{ label: 'MUTATION', text: 'x' }],
        cost: { promptTokens: -100, completionTokens: -50, usd: -40, calls: -24 },
      }),
    } as any);
    let settled = 0;
    const budget = {
      reserve: async () => 0, release: () => {},
      exhausted: () => false,
      accrueChild: (cost: any) => { settled += cost.usd; },
    };
    const parents = [makeParent('p1')];
    const { costTracking } = await createNextGeneration(parents, parents, 1, makeConfig(custom), [parents], budget);
    expect(costTracking.usd).toBe(0);
    expect(costTracking.calls).toBe(0);
    expect(settled).toBe(0);
  });

  it('a HUNG operator\'s last self-reported spend reaches cost tracking (F2: 67% invisible)', async () => {
    registerOperator({
      name: 'probe', parents: 1,
      apply: async ({ shouldAbort }: any) => {
        shouldAbort(0.05); // it reported billing $0.05…
        await new Promise(() => { /* …then hung forever */ });
      },
    } as any);
    const parents = [makeParent('p1')];
    const config = makeConfig({
      ...custom, callTimeoutMs: 50, retries: 1,
      population: { initialSize: 1, generationSize: 1, seedPrompt: 's', fill: 'auto' },
    } as any);
    const { newNodes, costTracking } = await createNextGeneration(parents, parents, 1, config, [parents]);
    expect(newNodes[0].changeLog[0].label).toBe('ERROR');
    expect(newNodes[0].changeLog[0].text).toMatch(/hung/i);
    // The floor it reported is in the books instead of $0.
    expect(costTracking.usd).toBeCloseTo(0.05, 10);
  });

  it('an absurd retries value cannot wrap the liveness timer (F7: insta-hung at retries 5000)', async () => {
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        await new Promise(r => setTimeout(r, 30));
        return { prompt: 'lively child', changeLog: [{ label: 'MUTATION', text: 'x' }], cost: { promptTokens: 1, completionTokens: 1, usd: 0.001, calls: 1 } };
      },
    } as any);
    const parents = [makeParent('p1')];
    const config = makeConfig({ ...custom, callTimeoutMs: 300000, retries: 5000 } as any);
    const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
    expect(newNodes[0].prompt).toBe('lively child');
    expect(newNodes[0].changeLog[0].label).toBe('MUTATION');
  });
});
