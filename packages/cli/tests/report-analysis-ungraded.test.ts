import { describe, it, expect } from 'vitest';
import { generateReport } from '../src/report.js';
import type { EvaluationConfig } from '@lineage/core';
import type { EvolutionResult } from '../src/engine.js';

/**
 * Open-bugs 2026-07-31 #6, observed as a self-contradicting document:
 *
 *   | 1 | TRAIN | 0.0 ⚠️ | 0.0 | 0.0 |          <- Improvement table
 *   ### Regressions
 *   - **TRAIN** (-5): Seed scored 5. Best scored 0 — clear answer.
 *
 * The Improvement table applies the fitness rule (an ungraded placeholder 5.0
 * counts 0, the row is marked ⚠️, the delta callout is suppressed) while the
 * Analysis section read raw `.score` — fabricating a regression out of a
 * failed judge, three lines below the table saying the opposite.
 */
const CONFIG = {
  id: 'cfg', name: 'Analysis Ungraded',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [
    { id: 't1', name: 'TRAIN', mode: 'llm_grade', prompt: 'train input' },
    { id: 't2', name: 'OTHER', mode: 'llm_grade', prompt: 'other input' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' },
  parallelLimit: 2,
} as unknown as EvaluationConfig;

function node(id: string, prompt: string, tests: any[]) {
  return {
    id, status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
    changeLog: [], lineageParents: [],
    metrics: { quality: 5, fitness: 5, costUSD: 0, latencyMs: 1 },
    tests,
  } as any;
}

const t = (testId: string, score: number, over: any = {}) => ({
  testId, passed: score >= 6, score,
  promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: `out-${testId}`,
  ...over,
});

function makeResult(seedTests: any[], bestTests: any[]): EvolutionResult {
  return {
    runId: 'r', configId: 'cfg', configName: 'Analysis Ungraded',
    startedAt: 1_700_000_000_000, finishedAt: 1_700_000_010_000, durationMs: 10_000,
    stopReason: 'generations',
    totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.01, calls: 4 },
    cacheHits: 0,
    ungradedTests: 1,
    generations: [{
      generation: 0,
      nodes: [node('seed', 'SEED PROMPT', seedTests), node('best', 'BEST PROMPT', bestTests)],
    }],
    best: { prompt: 'BEST PROMPT', fitness: 5, quality: 5, model: 'openai/m', nodeId: 'best', generation: 0 },
  } as EvolutionResult;
}

describe('the Analysis section agrees with the Improvement table on ungraded rows', () => {
  // The observed case: seed's TRAIN row is a placeholder 5.0 from a judge that
  // could not be read; best's TRAIN row genuinely scored 0.
  const md = generateReport(
    makeResult(
      [t('t1', 5, { ungraded: true, llmGradeReasoning: 'not parseable' }), t('t2', 4)],
      [t('t1', 0), t('t2', 8)],
    ),
    CONFIG,
  );
  const analysis = md.split('## Analysis')[1] ?? '';

  it('does not fabricate a regression from a placeholder score', () => {
    expect(analysis).not.toMatch(/### Regressions[\s\S]*TRAIN/);
    expect(analysis).not.toContain('(-5)');
  });

  it('lists the row as not graded instead', () => {
    expect(analysis).toMatch(/### Not graded/);
    expect(analysis).toMatch(/\*\*TRAIN\*\*/);
    expect(analysis).toMatch(/could not be graded/i);
  });

  it('still reports the genuinely graded row as a win', () => {
    expect(analysis).toMatch(/### Wins[\s\S]*\*\*OTHER\*\* \(\+4\)/);
  });

  it('names which side failed to grade', () => {
    expect(analysis).toMatch(/seed/i);
  });
});

describe('an ungraded BEST row cannot fabricate a win either', () => {
  const md = generateReport(
    makeResult(
      [t('t1', 0), t('t2', 4)],
      [t('t1', 5, { ungraded: true }), t('t2', 8)],
    ),
    CONFIG,
  );
  const analysis = md.split('## Analysis')[1] ?? '';

  it('keeps the placeholder out of Wins', () => {
    const wins = analysis.split('### Wins')[1]?.split('###')[0] ?? '';
    expect(wins).not.toContain('**TRAIN**');
    const notGraded = analysis.split('### Not graded')[1]?.split('###')[0] ?? '';
    expect(notGraded).toContain('**TRAIN**');
  });
});
