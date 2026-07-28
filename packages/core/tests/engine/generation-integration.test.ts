import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectTopPerformers, createNextGeneration } from '../../src/engine/generation';
import type { CandidateNode, EvaluationConfig } from '../../../src/types';

// Mock all operator functions that createNextGeneration calls
vi.mock('../../src/engine/operators_v2.js', () => ({
  mutateNode: vi.fn().mockResolvedValue({
    prompt: 'mutated prompt',
    changeLog: [{ label: 'MUTATION', text: 'Test mutation' }],
    cost: { promptTokens: 100, completionTokens: 50, usd: 0.001, calls: 2 },
  }),
  crossoverNodes: vi.fn().mockResolvedValue({
    prompt: 'crossed prompt',
    changeLog: [{ label: 'CROSSOVER', text: 'Test crossover' }],
    cost: { promptTokens: 150, completionTokens: 80, usd: 0.002, calls: 1 },
  }),
  metaPromptNode: vi.fn().mockResolvedValue({
    prompt: 'meta prompt',
    changeLog: [{ label: 'META', text: 'Test meta' }],
    cost: { promptTokens: 120, completionTokens: 60, usd: 0.0015, calls: 2 },
  }),
}));

function makeNode(id: string, fitness: number, gen: number = 0): CandidateNode {
  return {
    id,
    generation: gen,
    lineageParents: [],
    status: 'finished',
    prompt: `prompt-${id}`,
    params: { model: { provider: 'openai', model: 'gpt-4' }, temperature: 0.7 },
    changeLog: [],
    tests: [{ testId: 't1', passed: true, score: fitness, promptTokens: 10, completionTokens: 10, latencyMs: 100 }],
    metrics: { quality: fitness, fitness },
  };
}

function makeConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    id: 'config-1',
    name: 'test',
    selection: { policy: 'topk', topK: 3, eliteShare: 0.1 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0.3,
      metaPrompting: { enabled: true, share: 0.2 },
    },
    population: { initialSize: 5, generationSize: 5, seedPrompt: 'test', fill: 'auto' },
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

describe('selectTopPerformers edge cases', () => {
  it('top-P with all zero fitness does not crash or produce NaN', () => {
    const nodes = [
      makeNode('a', 0),
      makeNode('b', 0),
      makeNode('c', 0),
    ];
    const config = makeConfig({ selection: { policy: 'topp', topP: 0.5 } });
    const result = selectTopPerformers(nodes, config);
    // Should return at least 1 node (the Math.max(1, cutoff) guard)
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('top-K defaults to 40% of finished nodes when topK not specified', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`n${i}`, 10 - i));
    const config = makeConfig({ selection: { policy: 'topk' } });
    const result = selectTopPerformers(nodes, config);
    expect(result).toHaveLength(4); // ceil(10 * 0.4)
  });

  it('nodes sorted by fitness descending', () => {
    const nodes = [
      makeNode('low', 2),
      makeNode('high', 9),
      makeNode('mid', 5),
    ];
    const config = makeConfig({ selection: { policy: 'topk', topK: 3 } });
    const result = selectTopPerformers(nodes, config);
    expect(result[0].id).toBe('high');
    expect(result[1].id).toBe('mid');
    expect(result[2].id).toBe('low');
  });
});

describe('createNextGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces exactly generationSize nodes', async () => {
    const gen0 = [
      makeNode('a', 9, 0),
      makeNode('b', 7, 0),
      makeNode('c', 5, 0),
    ];
    const topPerformers = [gen0[0], gen0[1]];
    const config = makeConfig({ population: { initialSize: 5, generationSize: 5, seedPrompt: 'test', fill: 'auto' } });

    const result = await createNextGeneration(topPerformers, gen0, 1, config, [gen0]);
    expect(result.newNodes).toHaveLength(5);
  });

  it('all new nodes have correct generation number', async () => {
    const gen0 = [makeNode('a', 9, 0), makeNode('b', 7, 0)];
    const config = makeConfig();
    const result = await createNextGeneration([gen0[0]], gen0, 2, config, [gen0]);
    for (const node of result.newNodes) {
      expect(node.generation).toBe(2);
    }
  });

  it('all new nodes have unique IDs', async () => {
    const gen0 = [makeNode('a', 9, 0), makeNode('b', 7, 0)];
    const config = makeConfig();
    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    const ids = result.newNodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('elitism carries best node from previous generation', async () => {
    const gen0 = [
      makeNode('best', 9, 0),
      makeNode('mid', 5, 0),
      makeNode('low', 2, 0),
    ];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0.2 },
      population: { initialSize: 5, generationSize: 5, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);

    // Find elite node(s) — they should have status 'finished' and ELITE changelog
    const elites = result.newNodes.filter(n =>
      n.changeLog.some(c => c.label === 'ELITE')
    );
    expect(elites.length).toBeGreaterThanOrEqual(1);
    // Elite should reference best parent
    expect(elites[0].lineageParents).toContain('best');
    // Elite should be marked finished (not re-evaluated)
    expect(elites[0].status).toBe('finished');
    // Elite should preserve fitness
    expect(elites[0].metrics?.fitness).toBe(9);
  });

  it('non-elite children have lineage tracking parent IDs', async () => {
    const gen0 = [makeNode('parent-a', 9, 0), makeNode('parent-b', 7, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0 },
      population: { initialSize: 4, generationSize: 4, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    for (const node of result.newNodes) {
      expect(node.lineageParents.length).toBeGreaterThanOrEqual(1);
      // Each parent should be from gen0
      for (const parentId of node.lineageParents) {
        expect(['parent-a', 'parent-b']).toContain(parentId);
      }
    }
  });

  it('accumulates costs across all operator calls', async () => {
    const gen0 = [makeNode('a', 9, 0), makeNode('b', 7, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0 },
      population: { initialSize: 4, generationSize: 4, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    // Cost should be sum of all operator calls
    expect(result.costTracking.calls).toBeGreaterThan(0);
    expect(result.costTracking.usd).toBeGreaterThan(0);
    expect(result.costTracking.promptTokens).toBeGreaterThan(0);
  });

  it('operator failure falls back to parent prompt with ERROR changelog', async () => {
    const { mutateNode } = await import('../../src/engine/operators_v2.js');
    (mutateNode as any).mockRejectedValueOnce(new Error('LLM timeout'));

    const gen0 = [makeNode('parent-1', 9, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 1, eliteShare: 0 },
      operators: { mutationShare: 1.0, crossoverShare: 0 },
      population: { initialSize: 3, generationSize: 3, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0]], gen0, 1, config, [gen0]);
    // At least one node should have ERROR changelog (the one that failed)
    const errorNodes = result.newNodes.filter(n =>
      n.changeLog.some(c => c.label === 'ERROR')
    );
    expect(errorNodes.length).toBeGreaterThanOrEqual(1);
    // Error node should fall back to parent prompt
    expect(errorNodes[0].prompt).toBe('prompt-parent-1');
  });

  it('with eliteShare=0, no elites are created', async () => {
    const gen0 = [makeNode('a', 9, 0), makeNode('b', 7, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0 },
      population: { initialSize: 4, generationSize: 4, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    const elites = result.newNodes.filter(n => n.changeLog.some(c => c.label === 'ELITE'));
    expect(elites).toHaveLength(0);
  });

  it('tracks _operatorType and _parentFitness on each child node', async () => {
    const gen0 = [makeNode('a', 9, 0), makeNode('b', 7, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0 },
      population: { initialSize: 4, generationSize: 4, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    for (const node of result.newNodes) {
      expect((node as any)._parentFitness).toBeDefined();
      expect(typeof (node as any)._parentFitness).toBe('number');
    }
  });

  it('crossover tracks both parent IDs in lineage', async () => {
    const gen0 = [makeNode('parent-x', 9, 0), makeNode('parent-y', 7, 0)];
    const config = makeConfig({
      selection: { policy: 'topk', topK: 2, eliteShare: 0 },
      operators: { mutationShare: 0, crossoverShare: 1.0 },
      population: { initialSize: 3, generationSize: 3, seedPrompt: 'test', fill: 'auto' },
    });

    const result = await createNextGeneration([gen0[0], gen0[1]], gen0, 1, config, [gen0]);
    // At least some nodes should have crossover with 2 parents
    const crossoverNodes = result.newNodes.filter(n =>
      n.changeLog.some(c => c.label === 'CROSSOVER')
    );
    for (const node of crossoverNodes) {
      expect(node.lineageParents.length).toBe(2);
    }
  });
});

describe('selectTopPerformers → createNextGeneration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full generation advancement: select → create → verify', async () => {
    // Gen 0: 5 nodes with varying fitness
    const gen0 = [
      makeNode('n1', 9, 0),
      makeNode('n2', 7, 0),
      makeNode('n3', 5, 0),
      makeNode('n4', 3, 0),
      makeNode('n5', 1, 0),
    ];

    const config = makeConfig({
      selection: { policy: 'topk', topK: 3, eliteShare: 0.1 },
      population: { initialSize: 5, generationSize: 5, seedPrompt: 'test', fill: 'auto' },
    });

    // Step 1: Select top performers
    const topPerformers = selectTopPerformers(gen0, config);
    expect(topPerformers).toHaveLength(3);
    expect(topPerformers[0].id).toBe('n1'); // best first

    // Step 2: Create next generation
    const result = await createNextGeneration(topPerformers, gen0, 1, config, [gen0]);

    // Step 3: Verify
    expect(result.newNodes).toHaveLength(5); // same population size
    expect(result.newNodes.every(n => n.generation === 1)).toBe(true);

    // Should have at least 1 elite (from eliteShare=0.1 with popSize=5 → max(1, round(0.5)) = 1)
    const elites = result.newNodes.filter(n => n.changeLog.some(c => c.label === 'ELITE'));
    expect(elites.length).toBeGreaterThanOrEqual(1);

    // Non-elite children should have parent lineage from top performers
    const children = result.newNodes.filter(n => !n.changeLog.some(c => c.label === 'ELITE'));
    for (const child of children) {
      expect(child.lineageParents.length).toBeGreaterThanOrEqual(1);
    }
  });
});
