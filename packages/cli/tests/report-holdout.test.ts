import { describe, it, expect } from 'vitest';
import { generateReport } from '../src/report.js';
import type { EvaluationConfig } from '@promptengine/core';
import type { EvolutionResult } from '../src/engine.js';

const CONFIG = {
  id: 'cfg', name: 'Holdout Honesty',
  selection: { policy: 'topk', topK: 3 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [
    { id: 'h1', name: 'HELD-OUT', mode: 'llm_grade', prompt: 'unseen', holdout: true },
    { id: 't2', name: 'TRAIN', mode: 'llm_grade', prompt: 'train input' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' },
  parallelLimit: 2,
} as unknown as EvaluationConfig;

function node(id: string, prompt: string, score: number) {
  return {
    id, status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
    changeLog: [], lineageParents: [],
    metrics: { quality: score, fitness: score, costUSD: 0, latencyMs: 1 },
    tests: [{ testId: 't2', passed: true, score, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
  } as any;
}

function makeResult(over: Partial<EvolutionResult> = {}): EvolutionResult {
  return {
    runId: 'r', configId: 'cfg', configName: 'Holdout Honesty',
    startedAt: 1_700_000_000_000, finishedAt: 1_700_000_010_000, durationMs: 10_000,
    stopReason: 'generations',
    totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.01, calls: 4 },
    cacheHits: 0,
    generations: [{ generation: 0, nodes: [node('seed', 'SEED', 1), node('best', 'BEST', 10)] }],
    best: { prompt: 'BEST', fitness: 10, quality: 10, model: 'openai/m', nodeId: 'best', generation: 0 },
    ...over,
  } as EvolutionResult;
}

const holdout = (over: Record<string, unknown>) =>
  makeResult({ holdout: { testIds: ['h1'], samplesPerTest: 1, ...over } } as any);

describe('the report is honest about the holdout', () => {
  it('flags a REGRESSION — the one thing a holdout exists to catch', () => {
    // An overfit run reported +9.0 on every training test while the holdout
    // went 10.00 -> 1.00. The table printed the truth, the Outcome was a green
    // tick, and the only prose was "### Wins". The case where a holdout is
    // ABSENT gets a loud warning; the case it exists to detect got none.
    const md = generateReport(holdout({
      seed: { score: 10, perTest: [{ testId: 'h1', score: 10 }] },
      champion: { score: 1, perTest: [{ testId: 'h1', score: 1 }] },
    }), CONFIG);

    expect(md).toMatch(/regress/i);
    expect(md).toContain('10.00');
    expect(md).toContain('1.00');
  });

  it('does not cry regression when the champion generalises', () => {
    const md = generateReport(holdout({
      seed: { score: 4, perTest: [{ testId: 'h1', score: 4 }] },
      champion: { score: 8, perTest: [{ testId: 'h1', score: 8 }] },
    }), CONFIG);
    expect(md).not.toMatch(/regress/i);
  });

  it('a PARTIAL holdout renders content, not a bare heading', () => {
    // When the circuit breaker fired between scoring the champion and the seed,
    // results.holdout carried `champion` and no `seed`. The SECTION was guarded
    // on (seed || champion || skipped) but the body only handled `skipped` or
    // `(seed && champion)`, so the run emitted the heading followed by nothing.
    const md = generateReport(holdout({
      champion: { score: 7, perTest: [{ testId: 'h1', score: 7 }] },
    }), CONFIG);

    const section = md.slice(md.indexOf('## Generalization'));
    expect(section.split('\n').filter(l => l.trim()).length).toBeGreaterThan(1);
    expect(section).toMatch(/incomplete|only the champion|no seed baseline/i);
  });

  it('does not claim no holdout ran when one partially did', () => {
    // holdoutRan = !!(seed && champion), so a partial holdout printed "No
    // holdout ran, and this run is graded by an LLM judge" — factually wrong:
    // a holdout test was configured and the champion WAS scored on it.
    const md = generateReport(holdout({
      champion: { score: 7, perTest: [{ testId: 'h1', score: 7 }] },
    }), CONFIG);
    expect(md).not.toMatch(/No holdout ran/i);
  });
});
