import { describe, it, expect } from 'vitest';
import { generateReport } from '../src/report.js';
import type { EvaluationConfig } from '@promptengine/core';

/**
 * Mutation testing found these three report branches survived the whole suite:
 * reverting `> 0` to `!== undefined`, `delta < -0.005` to `delta < 0`, and
 * `Math.abs(delta) <= 0.005` to `delta === 0` all stayed green. Each one is a
 * false statement printed in the artefact the user keeps.
 */
const cfg = (weights: any) => ({
  id: 'c', name: 'Branches',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [{ id: 'h1', name: 'HELD', mode: 'llm_grade', prompt: 'p', holdout: true }],
  fitness: { weights },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' },
  parallelLimit: 1,
} as unknown as EvaluationConfig);

const node = (safety?: number) => ({
  id: 'n', status: 'finished', prompt: 'P',
  params: { model: { provider: 'openai', model: 'm' }, temperature: 0 },
  changeLog: [], lineageParents: [],
  metrics: { quality: 8, fitness: 8, costUSD: 0, latencyMs: 1, ...(safety !== undefined ? { safety } : {}) },
  tests: [{ testId: 'h1', passed: true, score: 8, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
} as any);

const result = (over: any = {}, safety?: number) => ({
  runId: 'r', configId: 'c', configName: 'Branches',
  startedAt: 1, finishedAt: 2, durationMs: 1, stopReason: 'generations',
  totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.01, calls: 2 },
  cacheHits: 0,
  generations: [{ generation: 0, nodes: [node(safety)] }],
  best: { prompt: 'P', fitness: 8, quality: 8, model: 'openai/m', nodeId: 'n', generation: 0 },
  ...over,
} as any);

const holdout = (seed: number, champion: number) => ({
  holdout: {
    testIds: ['h1'], samplesPerTest: 1,
    seed: { score: seed, perTest: [{ testId: 'h1', score: seed }] },
    champion: { score: champion, perTest: [{ testId: 'h1', score: champion }] },
  },
});

describe('the Unmeasured row tracks the weight, not its presence', () => {
  it('stays silent for a dimension explicitly disabled with weight 0', () => {
    // fitness.ts gates on `weights.safety ?`, so 0 means never computed. Testing
    // `!== undefined` printed "safety carried a weight but could not be
    // measured" directly under a row reading `safety=0`.
    const md = generateReport(result({}, undefined), cfg({ quality: 1, safety: 0 }));
    expect(md).not.toMatch(/Unmeasured/i);
  });

  it('still fires for a real weight that could not be measured', () => {
    const md = generateReport(result({}, undefined), cfg({ quality: 1, safety: 0.5 }));
    expect(md).toMatch(/Unmeasured/i);
  });
});

describe('the holdout delta branches use the displayed precision', () => {
  it('does not call a mathematically flat holdout a REGRESSION', () => {
    // Exact comparison printed "REGRESSED (0.78 -> 0.78, -0.00)" when two
    // permuted multisets of thirds differ in the last float bit.
    const md = generateReport(result(holdout(7 / 9, 7 / 9 - 1e-16)), cfg({ quality: 1 }));
    expect(md).not.toMatch(/REGRESSED/i);
  });

  it('still calls a real regression a regression', () => {
    const md = generateReport(result(holdout(9, 3)), cfg({ quality: 1 }));
    expect(md).toMatch(/REGRESSED/i);
  });

  it('flags a flat holdout that differs only in the last float bit', () => {
    const md = generateReport(result(holdout(7 / 9, 7 / 9 - 1e-16)), cfg({ quality: 1 }));
    expect(md).toMatch(/No measured improvement/i);
  });
});
