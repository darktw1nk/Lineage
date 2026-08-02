import { describe, it, expect } from 'vitest';
import { generateReport, slugify } from '../src/report.js';
import type { EvaluationConfig } from '@voxor/lineage-core';
import type { EvolutionResult } from '../src/engine.js';

// Test 1 is held out, so node.tests contains ONLY tests 2 and 3 — the shape
// that used to shift every label, input and output by one.
const CONFIG = {
  id: 'cfg', name: 'Holdout Report',
  selection: { policy: 'topk', topK: 3 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [
    { id: 'h1', name: 'AAA-holdout', mode: 'exact_match', prompt: 'held out input', expected: 'X', holdout: true },
    { id: 't2', name: 'BBB-training', mode: 'llm_grade', prompt: 'bbb input' },
    { id: 't3', name: 'CCC-training', mode: 'llm_grade', prompt: 'ccc input' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' },
  parallelLimit: 2,
} as unknown as EvaluationConfig;

function node(id: string, prompt: string, scores: [number, number], fitness: number) {
  return {
    id, status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
    changeLog: [], lineageParents: [],
    metrics: { quality: fitness, fitness, costUSD: 0, latencyMs: 1 },
    tests: [
      { testId: 't2', passed: true, score: scores[0], promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'out-bbb' },
      { testId: 't3', passed: true, score: scores[1], promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'out-ccc' },
    ],
  } as any;
}

function makeResult(over: Partial<EvolutionResult> = {}): EvolutionResult {
  return {
    runId: 'r', configId: 'cfg', configName: 'Holdout Report',
    startedAt: 1_700_000_000_000, finishedAt: 1_700_000_010_000, durationMs: 10_000,
    stopReason: 'generations',
    totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.01, calls: 4 },
    cacheHits: 0,
    generations: [{
      generation: 0,
      nodes: [node('seed', 'SEED PROMPT', [4, 4], 4), node('best', 'BEST PROMPT', [6, 6], 6)],
    }],
    best: { prompt: 'BEST PROMPT', fitness: 6, quality: 6, model: 'openai/m', nodeId: 'best', generation: 0 },
    ...over,
  } as EvolutionResult;
}

describe('generateReport with a holdout test', () => {
  const md = generateReport(makeResult(), CONFIG);

  it('names each result by its own test, not by position', () => {
    // The shift showed AAA (never run) with BBB's numbers and BBB with CCC's.
    expect(md).toMatch(/\*\*Test 1: BBB-training\*\* — Score: \*\*4\*\*\/10/);
    expect(md).toMatch(/\*\*Test 2: CCC-training\*\* — Score: \*\*4\*\*\/10/);
    expect(md).not.toMatch(/Test \d: AAA-holdout/);
  });

  it('pairs each result with its own input', () => {
    expect(md).toContain('> Input: bbb input');
    expect(md).not.toContain('> Input: held out input');
  });

  it('averages over the tests actually run', () => {
    // Dividing by config.testSet.length invented a 0.0/0.0 row for the held-out
    // test and reported 2.7 -> 4.0 instead of the true 4.0 -> 6.0.
    expect(md).toMatch(/\| \*\*Average\*\* \| \*\*4\.0\*\* \| \*\*6\.0\*\* \| \*\*\+2\.0\*\* \|/);
    expect(md).not.toMatch(/\| \d \| AAA-holdout \|/);
  });

  it('says why the run stopped', () => {
    expect(md).toContain('## Outcome');
    expect(md).toContain('ran out of generations');
  });
});

describe('generateReport formatting hazards', () => {
  it('fences a prompt that itself contains a code fence', () => {
    const fencedPrompt = 'Reply in JSON:\n```json\n{"a":1}\n```\nNothing else.';
    const result = makeResult({
      generations: [{ generation: 0, nodes: [node('seed', fencedPrompt, [4, 4], 4), node('best', fencedPrompt, [6, 6], 6)] }],
      best: { prompt: fencedPrompt, fitness: 6, quality: 6, model: 'openai/m', nodeId: 'best', generation: 0 },
    } as any);
    const md = generateReport(result, CONFIG);
    // A bare ``` fence terminated at the prompt's own fence, spilling the rest
    // as prose and swallowing the next heading.
    expect(md).toContain('````\nReply in JSON:');
    expect(md).toContain('## Improvement Summary');
  });

  it('keeps a newline in a test name from breaking the table', () => {
    const config = {
      ...CONFIG,
      testSet: [CONFIG.testSet[0], { ...CONFIG.testSet[1], name: 'newline\nin name' }, CONFIG.testSet[2]],
    } as EvaluationConfig;
    const md = generateReport(makeResult(), config);
    expect(md).toContain('| 1 | newline in name |');
    expect(md).not.toMatch(/\| 1 \| newline\n/);
  });

  it('a run where everything failed is not a green checkmark', () => {
    // stopReason 'exhausted' rendered as "✅ no candidates left to evaluate",
    // so a run in which every candidate died on a bad API key opened with a
    // green tick and never named the cause — which sat in results.json only.
    const dead = (id: string) => ({
      id, status: 'failed', prompt: 'p',
      params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
      changeLog: [], lineageParents: [], metrics: null, tests: null,
      error: 'OpenAI API error: 401 - Incorrect API key provided: sk-fake-****ABCD',
    } as any);
    const md = generateReport(makeResult({
      stopReason: 'exhausted',
      generations: [{ generation: 0, nodes: [dead('a'), dead('b')] }],
      best: null,
    } as any), CONFIG);

    expect(md).toContain('❌ **Every candidate failed**');
    expect(md).not.toContain('✅');
    expect(md).toContain('Incorrect API key provided');
  });

  it('reports failed candidates instead of hiding them', () => {
    const result = makeResult({
      generations: [{
        generation: 0,
        nodes: [node('seed', 'SEED PROMPT', [4, 4], 4), node('best', 'BEST PROMPT', [6, 6], 6), { id: 'dead', status: 'failed', prompt: 'x', params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 }, changeLog: [], lineageParents: [], metrics: null, tests: null } as any],
      }],
    } as any);
    const md = generateReport(result, CONFIG);
    expect(md).toContain('1 of 3 candidates failed');
  });

  it('does not claim a playoff picked the champion when the final generation had none', () => {
    const md = generateReport(makeResult({ playoffs: [{ generation: 5, ranking: ['best'] }] } as any), CONFIG);
    expect(md).not.toContain('Champion selected by pairwise playoff');
    expect(md).toContain('selected by fitness');
  });
});

describe('slugify', () => {
  it('never returns an empty slug', () => {
    // '日本語' reduced to '', so every non-ASCII run wrote to the same file.
    expect(slugify('日本語')).toBe('run');
    expect(slugify('My Run')).toBe('my-run');
  });
});

describe('model-written text cannot inject markdown into the report', () => {
  it('neutralises links and raw HTML in a candidate output', () => {
    // escapeMarkdown escaped `|` and newlines but not `[` or `<`, unlike
    // escapeMarkdownProse. Candidate output is rendered into `> Output:` lines,
    // so a candidate could put a live external link and raw HTML into the
    // artifact a human reads to decide whether the run worked.
    const evil = 'PARIS [click here](http://evil.example) <img src=x onerror=alert(1)>';
    const withEvil = makeResult({
      generations: [{
        generation: 0,
        nodes: [node('seed', 'SEED PROMPT', [4, 4], 4), node('best', 'BEST PROMPT', [6, 6], 6)],
      }],
    } as any);
    withEvil.generations[0].nodes[1].tests[0].outputText = evil;
    const md = generateReport(withEvil, CONFIG);

    // The bracket must be escaped, so the link syntax never forms.
    expect(md).not.toContain('[click here](');
    expect(md).toContain('\\[click here\\]');
    expect(md).not.toContain('<img src=x');
  });

  it('escapes a changelog label, not just its text', () => {
    // One of the two changelog render paths interpolated `change.label` raw.
    const withLabel = makeResult();
    withLabel.generations[0].nodes[1].changeLog = [
      { label: 'X](http://evil.example) #Forged', text: 'ordinary text' } as any,
    ];
    const md = generateReport(withLabel, CONFIG);
    // The changelog template wraps the label in `**[...]**`, so a label
    // containing `]` closes the bracket the TEMPLATE opened and the `(url)`
    // after it renders as a live link. The property is that no `](` in the
    // document is unescaped — `\](` is inert, and asserting the raw substring
    // is absent would be unsatisfiable because `\](` contains it.
    expect(md).not.toMatch(/[^\\]\]\(/);
    expect(md).toContain('X\\]');
  });
});

describe('a multi-sample test does not attribute one sample to the mean', () => {
  it('labels the shown output as one sample and lists the sample scores', () => {
    // score is the MEAN across samples but outputText and the justification
    // come from samples[0]. With samples [10, 1, 1] the report printed
    // 'Score: 4/10' directly above the one output that passed, and a 10/10
    // justification welded to a 4/10 score.
    const r = makeResult();
    const best = r.generations[0].nodes[1] as any;
    best.tests[0].score = 4;
    best.tests[0].samples = [10, 1, 1];
    best.tests[0].outputText = 'PARIS';
    const md = generateReport(r, CONFIG);

    expect(md).toMatch(/sample 1 of 3/);
    expect(md).toContain('10, 1, 1');
  });

  it('says nothing extra for a single-sample test', () => {
    const md = generateReport(makeResult(), CONFIG);
    expect(md).not.toMatch(/sample 1 of/);
  });
});
