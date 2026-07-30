import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai', estimateTokens: () => ({ prompt: 1 }),
    call: async () => ({ output: 'stub', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
  }),
}));

import { createNextGeneration, selectTopPerformers } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry } from '../../src/registry.js';
import { withPartialCost } from '../../src/engine/operator-cost.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * `validateOperatorResult`, `snapshot`, `withOperatorTimeout` and the operator
 * budget gate are the entire contract docs/plugins.md promises third-party
 * operators: "a bad plugin contributes nothing and the host keeps running".
 * Mutation testing (pass 8) removed every one of them with 595 tests green.
 */
function makeParent(id: string, fitness = 5): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished', prompt: `prompt-${id}`,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  } as CandidateNode;
}

function makeConfig(over: Partial<EvaluationConfig> = {}, custom: any = { probe: { share: 1 } }): EvaluationConfig {
  return {
    id: 'c1', name: 'operator contract',
    selection: { policy: 'topk', topK: 4 },
    operators: { mutationShare: 0, crossoverShare: 0, custom },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as EvaluationConfig;
}

const run = (parents: CandidateNode[], config: EvaluationConfig, budget?: any) =>
  createNextGeneration(parents, parents, 1, config, [parents], budget);

/** Register an operator whose apply() returns whatever the test wants. */
function registerProbe(result: any | (() => any), parents: 1 | 2 = 1) {
  registerOperator({
    name: 'probe', parents,
    apply: async () => (typeof result === 'function' ? result() : result),
  } as any);
}

const GOOD_COST = { promptTokens: 1, completionTokens: 1, usd: 0.01, calls: 1 };

beforeEach(() => resetRegistry());

describe('a malformed operator result is refused, never used', () => {
  const badResults: Array<[string, any]> = [
    ['undefined', undefined],
    ['a bare string', 'just a prompt'],
    ['an empty prompt', { prompt: '   ', changeLog: [], cost: GOOD_COST }],
    ['a non-string prompt', { prompt: 42, changeLog: [], cost: GOOD_COST }],
  ];

  for (const [label, bad] of badResults) {
    it(`carries the parent forward when the operator returns ${label}`, async () => {
      registerProbe(bad);
      const parents = [makeParent('p1'), makeParent('p2')];
      const { newNodes } = await run(parents, makeConfig());

      // Every child must be a usable candidate...
      for (const n of newNodes) {
        expect(typeof n.prompt).toBe('string');
        expect(n.prompt.trim().length).toBeGreaterThan(0);
      }
      // ...and the failure must be visible in the changelog, not silent.
      expect(newNodes.some(n => n.changeLog[0]?.label === 'ERROR')).toBe(true);
      expect(newNodes.every(n => (n as any)._operatorType === null)).toBe(true);
    });
  }

  it('never lets a non-finite cost reach run totals', async () => {
    // NaN in totals.usd disables budgetUSD entirely: NaN >= limit is never true.
    registerProbe({ prompt: 'ok', changeLog: [], cost: { promptTokens: NaN, completionTokens: Infinity, usd: NaN, calls: '3' } });
    const { costTracking } = await run([makeParent('p1')], makeConfig());
    for (const v of Object.values(costTracking)) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(costTracking.usd).toBe(0);
  });

  it('never lets a garbage changeLog or params reach a node', async () => {
    registerProbe({ prompt: 'ok', changeLog: 'not an array', params: ['not', 'an', 'object'], cost: GOOD_COST });
    const { newNodes } = await run([makeParent('p1')], makeConfig());
    for (const n of newNodes) {
      expect(Array.isArray(n.changeLog)).toBe(true);
      expect(Array.isArray(n.params)).toBe(false);
      expect((n.params as any)['0']).toBeUndefined(); // array indices must not become params
      expect(n.params.model).toBeDefined();      // inherited from the parent
      expect(typeof n.params.temperature).toBe('number');
    }
  });

  it('names the failing operator in the changelog text', async () => {
    registerProbe(() => { throw new Error('plugin exploded'); });
    const { newNodes } = await run([makeParent('p1')], makeConfig());
    const err = newNodes.find(n => n.changeLog[0]?.label === 'ERROR')!;
    expect(err.changeLog[0].text).toContain("probe");
    expect(err.changeLog[0].text).toContain('plugin exploded');
  });
});

describe('operators cannot reach into live state', () => {
  it('mutating the parent it was handed does not damage the scored parent', async () => {
    // A plugin that wrote to `parent` rewrote the already-evaluated node in
    // place, and every sibling saw the damage because they shared the object.
    let leaked: CandidateNode | null = null;
    registerOperator({
      name: 'probe', parents: 1,
      apply: async ({ parent }: any) => {
        parent.prompt = 'HIJACKED';
        parent.metrics.fitness = 999;
        leaked = parent;
        return { prompt: 'child', changeLog: [], cost: GOOD_COST };
      },
    } as any);

    const p1 = makeParent('p1');
    await run([p1], makeConfig());
    expect(leaked).not.toBe(p1);
    expect(p1.prompt).toBe('prompt-p1');
    expect(p1.metrics!.fitness).toBe(5);
  });

  it('the `generation` array it reads is a copy too', async () => {
    const p1 = makeParent('p1');
    registerOperator({
      name: 'probe', parents: 1,
      apply: async ({ generation }: any) => {
        generation[0].prompt = 'HIJACKED';
        return { prompt: 'child', changeLog: [], cost: GOOD_COST };
      },
    } as any);
    await run([p1], makeConfig());
    expect(p1.prompt).toBe('prompt-p1');
  });
});

describe('a hung operator is bounded, a slow one is not punished', () => {
  it('an apply() that never resolves is treated as hung', async () => {
    registerOperator({
      name: 'probe', parents: 1,
      apply: () => new Promise(() => { /* never resolves */ }),
    } as any);
    const { newNodes } = await run([makeParent('p1')], makeConfig({ callTimeoutMs: 20 }));
    const err = newNodes.find(n => n.changeLog[0]?.label === 'ERROR')!;
    expect(err.changeLog[0].text).toMatch(/hung/);
    expect(err.prompt).toBe('prompt-p1'); // carried forward
  }, 20000);

  it('allows an operator SEVERAL calls worth of time, not one', async () => {
    // The timeout is a liveness check, not a latency budget: mutation makes up
    // to retries+1 proposal calls plus an apply call. Bounding the operator by
    // ONE callTimeoutMs turned every mutation into a carry-forward.
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        await new Promise(r => setTimeout(r, 120)); // 2.4 x callTimeoutMs
        return { prompt: 'slow child', changeLog: [{ label: 'OK', text: 'done' }], cost: GOOD_COST };
      },
    } as any);
    const { newNodes } = await run([makeParent('p1')], makeConfig({ callTimeoutMs: 50 }));
    expect(newNodes.every(n => n.prompt === 'slow child')).toBe(true);
  }, 20000);

  it('callTimeoutMs 0 disables the operator timeout rather than failing everything', async () => {
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        await new Promise(r => setTimeout(r, 30));
        return { prompt: 'child', changeLog: [], cost: GOOD_COST };
      },
    } as any);
    const { newNodes } = await run([makeParent('p1')], makeConfig({ callTimeoutMs: 0 } as any));
    expect(newNodes.every(n => n.prompt === 'child')).toBe(true);
  }, 20000);
});

describe('the operator batch respects the budget hook', () => {
  it('carries children forward once exhausted() goes true, without calling apply', async () => {
    let applied = 0;
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => { applied++; return { prompt: 'child', changeLog: [], cost: GOOD_COST }; },
    } as any);
    let exhausted = false;
    const { newNodes } = await run([makeParent('p1')], makeConfig({ population: { initialSize: 6, generationSize: 6, seedPrompt: 's', fill: 'auto' } } as any), {
      reserve: async () => 0,
      release: () => {},
      exhausted: () => { const was = exhausted; exhausted = true; return was; }, // false once, then true
    });
    expect(applied).toBe(1);
    const carried = newNodes.filter(n => n.changeLog[0]?.text === 'Budget exhausted before this operator ran');
    expect(carried).toHaveLength(5);
    expect(carried.every(n => n.prompt === 'prompt-p1')).toBe(true);
  });

  it('a REFUSED reservation is a CARRY, not an operator ERROR', async () => {
    // A refusal is the cap working. Reporting it as an error made the run look
    // broken and hid the real reason behind "Operator 'x' failed".
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => ({ prompt: 'child', changeLog: [], cost: GOOD_COST }),
    } as any);
    const refuse = () => { const e: any = new Error('Budget exhausted'); e.name = 'BudgetExhaustedError'; throw e; };
    const { newNodes, costTracking } = await run([makeParent('p1')], makeConfig(), {
      reserve: async () => refuse(),
      release: () => {},
      exhausted: () => false,
    });
    expect(newNodes.every(n => n.changeLog[0]?.label === 'CARRY')).toBe(true);
    expect(newNodes.some(n => n.changeLog[0]?.label === 'ERROR')).toBe(false);
    expect(costTracking.calls).toBe(0);
  });
});

describe('Top-P selection cannot collapse the parent pool', () => {
  const cfg = (topP: number) => ({
    ...makeConfig(), selection: { policy: 'topp', topP },
  } as EvaluationConfig);

  it('takes everyone when every candidate scored zero', async () => {
    // totalFitness 0 makes the cumulative share 0/0 = NaN, so no cutoff can
    // ever trip; collapsing to a single parent kills diversity outright.
    const nodes = [makeParent('a', 0), makeParent('b', 0), makeParent('c', 0)];
    expect(selectTopPerformers(nodes, cfg(0.5))).toHaveLength(3);
  });

  it('topP 1.0 takes everyone despite floating-point error', async () => {
    const nodes = [makeParent('a', 1), makeParent('b', 1), makeParent('c', 1)];
    expect(selectTopPerformers(nodes, cfg(1.0))).toHaveLength(3);
  });

  it('never returns zero parents', async () => {
    const nodes = [makeParent('a', 9), makeParent('b', 1)];
    for (const p of [0, -1, 0.0001]) {
      expect(selectTopPerformers(nodes, cfg(p)).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('elitism arithmetic', () => {
  it('subtracts the elites actually carried, not the number requested', async () => {
    // With fewer finished nodes than eliteShare asks for, subtracting the
    // REQUEST silently shrinks the generation below generationSize.
    registerProbe({ prompt: 'child', changeLog: [], cost: GOOD_COST });
    const parents = [makeParent('p1')];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 4, eliteShare: 0.5 },
      population: { initialSize: 8, generationSize: 8, seedPrompt: 's', fill: 'auto' },
    } as any);
    // Only ONE finished node exists, so at most 1 elite can be carried.
    const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
    expect(newNodes).toHaveLength(8);
  });

  it('carries at least one elite whenever eliteShare is enabled', async () => {
    registerProbe({ prompt: 'child', changeLog: [], cost: GOOD_COST });
    const parents = [makeParent('p1', 9), makeParent('p2', 1)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0.01 }, // rounds to 0
      population: { initialSize: 10, generationSize: 10, seedPrompt: 's', fill: 'auto' },
    } as any);
    const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
    const elites = newNodes.filter(n => n.changeLog[0]?.label === 'ELITE');
    expect(elites).toHaveLength(1);
    expect(elites[0].prompt).toBe('prompt-p1'); // the best one
  });
});

describe('operator planning arithmetic', () => {
  it('uses the built-in 120s liveness bound when callTimeoutMs is unset', async () => {
    // `?? 120_000` is the default. A mutated default of 1ms turns every
    // operator into a carry-forward on a config that never set callTimeoutMs.
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        await new Promise(r => setTimeout(r, 40));
        return { prompt: 'child', changeLog: [], cost: GOOD_COST };
      },
    } as any);
    const config = makeConfig();
    delete (config as any).callTimeoutMs;
    const { newNodes } = await run([makeParent('p1')], config);
    expect(newNodes.every(n => n.prompt === 'child')).toBe(true);
  }, 20000);

  it('gives a better parent strictly more children than a worse one', async () => {
    registerProbe({ prompt: 'child', changeLog: [], cost: GOOD_COST });
    const parents = [makeParent('best', 9), makeParent('mid', 5), makeParent('worst', 1)];
    const config = makeConfig({
      population: { initialSize: 12, generationSize: 12, seedPrompt: 's', fill: 'auto' },
      seed: 7,
    } as any);
    const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
    const count = (id: string) => newNodes.filter(n => n.lineageParents[0] === id).length;
    expect(count('best')).toBeGreaterThan(count('worst'));
    expect(count('worst')).toBeGreaterThanOrEqual(1); // every parent still contributes
  });

  it('always produces exactly generationSize children, whatever the shares', async () => {
    // Both the parent distribution and the operator plan use largest-remainder
    // top-ups; dropping either silently shrinks the generation.
    registerOperator({ name: 'a', parents: 1, apply: async () => ({ prompt: 'A', changeLog: [], cost: GOOD_COST }) } as any);
    registerOperator({ name: 'b', parents: 1, apply: async () => ({ prompt: 'B', changeLog: [], cost: GOOD_COST }) } as any);
    registerOperator({ name: 'c', parents: 1, apply: async () => ({ prompt: 'C', changeLog: [], cost: GOOD_COST }) } as any);
    for (const size of [7, 10, 11]) {
      const parents = [makeParent('p1', 9), makeParent('p2', 5), makeParent('p3', 1)];
      const config = makeConfig({
        population: { initialSize: size, generationSize: size, seedPrompt: 's', fill: 'auto' },
      } as any, { a: { share: 1 }, b: { share: 1 }, c: { share: 1 } });
      const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
      expect(newNodes).toHaveLength(size);
      // …and every one of them was actually assigned an operator. Dropping the
      // largest-remainder top-up leaves the tail of the plan empty, so the last
      // children carry their parent forward for no reason.
      expect(newNodes.some(n => n.changeLog[0]?.text === 'No operator assigned (all shares 0)')).toBe(false);
    }
  });

  it('a DISABLED operator gets no children (operators.custom)', async () => {
    registerOperator({ name: 'a', parents: 1, apply: async () => ({ prompt: 'A', changeLog: [], cost: GOOD_COST }) } as any);
    registerOperator({ name: 'off', parents: 1, apply: async () => ({ prompt: 'OFF', changeLog: [], cost: GOOD_COST }) } as any);
    const parents = [makeParent('p1')];
    const { newNodes } = await createNextGeneration(
      parents, parents, 1,
      makeConfig({}, { a: { share: 1 }, off: { share: 5, enabled: false } }),
      [parents],
    );
    expect(newNodes.every(n => n.prompt === 'A')).toBe(true);
  });

  it('a DISABLED built-in operator gets no children (legacy fields)', async () => {
    // metaPrompting/paramVariation/modelVariation carry BOTH an `enabled` flag
    // and a `share`. Reading the share without the flag hands most of the
    // generation to an operator the user switched off.
    registerOperator({ name: 'a', parents: 1, apply: async () => ({ prompt: 'A', changeLog: [], cost: GOOD_COST }) } as any);
    const parents = [makeParent('p1')];
    const config = makeConfig({}, { a: { share: 1 } });
    (config.operators as any).metaPrompting = { enabled: false, share: 5 };
    (config.operators as any).paramVariation = { enabled: false, share: 5 };
    (config.operators as any).modelVariation = { enabled: false, share: 5 };
    const { newNodes } = await createNextGeneration(parents, parents, 1, config, [parents]);
    expect(newNodes.every(n => n.prompt === 'A')).toBe(true);
    expect(newNodes.every(n => (n as any)._operatorType === 'a')).toBe(true);
  });

  it('a child always has a usable temperature', async () => {
    // params.temperature feeds straight into the provider call; undefined
    // silently changes what every provider does.
    registerProbe({ prompt: 'child', changeLog: [], params: {}, cost: GOOD_COST });
    const bare = { ...makeParent('p1'), params: { model: { provider: 'openai', model: 'gpt-x' } } } as any;
    const { newNodes } = await createNextGeneration([bare], [bare], 1, makeConfig(), [[bare]]);
    expect(newNodes.every(n => typeof n.params.temperature === 'number')).toBe(true);
  });

  it('a binary operator never merges a prompt with itself', async () => {
    // Cycling the assignment list blindly handed crossover the same node twice
    // whenever one performer dominated — a full service call for nothing.
    registerOperator({
      name: 'probe', parents: 2,
      apply: async ({ parent, parentB }: any) => ({
        prompt: `${parent.prompt}+${parentB.prompt}`, changeLog: [], cost: GOOD_COST,
      }),
    } as any);
    const parents = [makeParent('p1', 9), makeParent('p2', 1)];
    const { newNodes } = await createNextGeneration(parents, parents, 1, makeConfig(), [parents]);
    for (const n of newNodes) {
      expect(n.lineageParents).toHaveLength(2);
      expect(n.lineageParents[0]).not.toBe(n.lineageParents[1]);
    }
  });

  it('accounts for the calls a failed operator already paid for', async () => {
    // A failing operator has usually already made (and been billed for) several
    // LLM calls; carrying zero hides that spend from totals and the budget.
    registerOperator({
      name: 'probe', parents: 1,
      apply: async () => {
        throw withPartialCost(new Error('judge returned prose'), { promptTokens: 5, completionTokens: 5, usd: 0.02, calls: 2 });
      },
    } as any);
    const { costTracking } = await run([makeParent('p1')], makeConfig());
    expect(costTracking.calls).toBeGreaterThan(0);
    expect(costTracking.usd).toBeGreaterThan(0);
  });
});
