import { describe, it, expect } from 'vitest';
import { generateReport } from '../src/report.js';
import type { EvaluationConfig } from '@voxor/lineage-core';
import type { EvolutionResult } from '../src/engine.js';

/**
 * The report must disclose what the weighting passed over — and must not
 * invent a trade-off when there wasn't one.
 */
const CONFIG = {
  id: 'cfg', name: 'P', selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [{ id: 't1', name: 'T', mode: 'llm_grade', prompt: 'a' }],
  fitness: { weights: { quality: 1 } }, targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' }, parallelLimit: 2,
} as unknown as EvaluationConfig;

const node = (id: string, metrics: any) => ({
  id, status: 'finished', prompt: `prompt ${id}`,
  params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
  changeLog: [], lineageParents: [], metrics,
  tests: [{ testId: 't1', passed: true, score: 7, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
} as any);

function makeResult(front: any[] | undefined, bestId = 'champ'): EvolutionResult {
  const champ = node('champ', { quality: 9, fitness: 9, costUSD: 0.10, latencyMs: 900 });
  const cheap = node('cheap', { quality: 6, fitness: 6, costUSD: 0.001, latencyMs: 120 });
  return {
    runId: 'r', configId: 'cfg', configName: 'P',
    startedAt: 1, finishedAt: 2, durationMs: 1, stopReason: 'generations',
    totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.1, calls: 4 }, cacheHits: 0,
    generations: [{ generation: 0, nodes: [champ, cheap] }],
    best: { prompt: champ.prompt, fitness: 9, quality: 9, model: 'openai/m', nodeId: bestId, generation: 0 },
    ...(front ? { paretoFront: front } : {}),
  } as EvolutionResult;
}

describe('the report names the trade-offs the weighting passed over', () => {
  const md = generateReport(makeResult([
    { nodeId: 'champ', generation: 0, metrics: { quality: 9, costUSD: 0.10, latencyMs: 900 } },
    { nodeId: 'cheap', generation: 0, metrics: { quality: 6, costUSD: 0.001, latencyMs: 120 } },
  ]), CONFIG);

  it('renders the section when a real alternative exists', () => {
    expect(md).toContain('## Trade-offs your weights passed over');
  });

  it('marks which row is the champion, so the comparison has an anchor', () => {
    const section = md.split('## Trade-offs your weights passed over')[1] ?? '';
    expect(section).toMatch(/champ.*\*\*\(champion\)\*\*/);
    expect(section).toContain('cheap');
  });

  it('shows the dimensions the alternative actually won on', () => {
    const section = md.split('## Trade-offs your weights passed over')[1] ?? '';
    expect(section).toContain('0.001000 USD');
    expect(section).toContain('120 ms');
  });

  it('tells the reader what to do about it', () => {
    const section = md.split('## Trade-offs your weights passed over')[1] ?? '';
    expect(section).toMatch(/fitness\.weights/);
  });
});

describe('it stays silent when there is nothing to disclose', () => {
  it('omits the section when the champion dominated everything', () => {
    const md = generateReport(makeResult([
      { nodeId: 'champ', generation: 0, metrics: { quality: 9, costUSD: 0.001, latencyMs: 100 } },
    ]), CONFIG);
    expect(md).not.toContain('## Trade-offs your weights passed over');
  });

  it('omits the section for a run that predates the feature', () => {
    const md = generateReport(makeResult(undefined), CONFIG);
    expect(md).not.toContain('## Trade-offs your weights passed over');
  });

  it('omits the section when the only front member IS the champion', () => {
    const md = generateReport(makeResult([
      { nodeId: 'champ', generation: 0, metrics: { quality: 9, costUSD: 0.1, latencyMs: 900 } },
      { nodeId: 'champ', generation: 0, metrics: { quality: 9, costUSD: 0.1, latencyMs: 900 } },
    ]), CONFIG);
    expect(md).not.toContain('## Trade-offs your weights passed over');
  });
});

describe('it filters front members that are technically non-dominated but useless', () => {
  it('drops a broken candidate that is only on the front for being fractionally cheaper', () => {
    // Observed in a real run: a quality-0.00 node made the front because it
    // cost three microdollars less than the champion. Listing it as a
    // "trade-off you passed over" is noise, not disclosure.
    const md = generateReport(makeResult([
      { nodeId: 'champ', generation: 0, metrics: { quality: 10, costUSD: 0.0000251, latencyMs: 2409 } },
      { nodeId: 'broken', generation: 1, metrics: { quality: 0, costUSD: 0.0000223, latencyMs: 2379 } },
    ]), CONFIG);
    expect(md).not.toContain('## Trade-offs your weights passed over');
  });

  it('keeps a genuinely cheaper alternative that still scores decently', () => {
    const md = generateReport(makeResult([
      { nodeId: 'champ', generation: 0, metrics: { quality: 9, costUSD: 0.10, latencyMs: 900 } },
      { nodeId: 'decent', generation: 1, metrics: { quality: 7, costUSD: 0.002, latencyMs: 150 } },
    ]), CONFIG);
    expect(md).toContain('## Trade-offs your weights passed over');
    expect(md).toContain('decent');
  });
});
