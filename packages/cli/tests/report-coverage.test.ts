import { describe, it, expect } from 'vitest';
import { generateReport } from '../src/report.js';
import type { EvaluationConfig } from '@promptengine/core';
import type { EvolutionResult } from '../src/engine.js';

/**
 * report.test.ts's makeResult() has ONE generation, no costBreakdown, no
 * estimate, no activeDurationMs, no samples and no failures — so the "Where the
 * money went" section, the Fitness Progression table beyond a single row, the
 * resumed-duration line, the spread annotation and the stale-playoff wording
 * have no test data at all. Mutation testing (pass 8) mutated every number in
 * those sections and the suite stayed green.
 *
 * ONE richer fixture unlocks all of them.
 */
const CONFIG = {
  id: 'cfg', name: 'Rich Report',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 3, generationSize: 3, seedPrompt: 'SEED PROMPT', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet: [
    { id: 'h1', name: 'HELD-OUT', mode: 'llm_grade', prompt: 'unseen input', holdout: true },
    { id: 't2', name: 'BBB-training', mode: 'llm_grade', prompt: 'bbb input' },
    { id: 't3', name: 'CCC-training', mode: 'llm_grade', prompt: 'ccc input' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 2 },
  serviceModel: { provider: 'openai', model: 'm' },
  parallelLimit: 2,
} as unknown as EvaluationConfig;

function node(id: string, prompt: string, scores: [number, number], fitness: number, over: any = {}) {
  return {
    id, status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
    changeLog: [{ label: 'MUTATION', text: `built ${id}` }], lineageParents: [],
    metrics: { quality: fitness, fitness, costUSD: 0.001, latencyMs: 10 },
    tests: [
      { testId: 't2', passed: true, score: scores[0], promptTokens: 1, completionTokens: 1, latencyMs: 1,
        outputText: 'out-bbb', llmGradeReasoning: JSON.stringify({ score: scores[0], justification: 'because bbb' }) },
      { testId: 't3', passed: true, score: scores[1], promptTokens: 1, completionTokens: 1, latencyMs: 1,
        outputText: 'out-ccc', llmGradeReasoning: JSON.stringify({ score: scores[1], justification: 'because ccc' }) },
    ],
    ...over,
  } as any;
}

const dead = (id: string) => ({
  id, status: 'failed', prompt: 'p',
  params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
  changeLog: [], lineageParents: [], metrics: null, tests: null,
  error: 'OpenAI API error: 429 - rate limited',
} as any);

/**
 * The enriched fixture. Two generations (one with a failure and one unscored
 * node), multi-sample tests, a full costBreakdown + estimate, a resumed-run
 * duration split, a holdout, a non-decisive playoff, and an ungraded count.
 */
export function makeRichResult(over: Partial<EvolutionResult> = {}): EvolutionResult {
  const seed = node('seed', 'SEED PROMPT', [4, 2], 3);
  const mid = node('mid', 'MID PROMPT', [5, 5], 5);
  const best = node('best', 'BEST PROMPT\nextra line', [8, 6], 7, {
    tests: [
      { testId: 't2', passed: true, score: 8, promptTokens: 1, completionTokens: 1, latencyMs: 1,
        outputText: 'out-bbb-best', samples: [10, 6],
        llmGradeReasoning: JSON.stringify({ score: 8, justification: 'because best bbb' }) },
      { testId: 't3', passed: true, score: 6, promptTokens: 1, completionTokens: 1, latencyMs: 1,
        outputText: 'out-ccc-best', samples: [6, 6],
        llmGradeReasoning: JSON.stringify({ score: 6, justification: 'because best ccc' }) },
    ],
    lineageParents: ['seed'],
    changeLog: [{ label: 'MUTATION', text: 'made it better' }],
  });
  const unscored = { ...node('unscored', 'X', [0, 0], 0), metrics: null, tests: null, status: 'awaiting' } as any;

  return {
    runId: 'r', configId: 'cfg', configName: 'Rich Report',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_000 + 8 * 60 * 60 * 1000, // 8h wall clock (resumed overnight)
    durationMs: 8 * 60 * 60 * 1000,
    activeDurationMs: 5 * 60 * 1000,                    // 5m of actual work
    stopReason: 'generations',
    seed: 42,
    testSet: [
      { id: 'h1', name: 'HELD-OUT', mode: 'llm_grade', holdout: true },
      { id: 't2', name: 'BBB-training', mode: 'llm_grade', holdout: false },
      { id: 't3', name: 'CCC-training', mode: 'llm_grade', holdout: false },
    ],
    totals: { tokensPrompt: 400, tokensCompletion: 200, usd: 0.5, calls: 40 },
    cacheHits: 3,
    ungradedTests: 2,
    generations: [
      { generation: 0, nodes: [seed, mid, dead('d0')] },
      { generation: 1, nodes: [best, node('sib', 'SIB PROMPT', [1, 1], 1), unscored] },
    ],
    best: { prompt: 'BEST PROMPT\nextra line', fitness: 7, quality: 7, model: 'openai/m', nodeId: 'best', generation: 1 },
    holdout: {
      testIds: ['h1'], samplesPerTest: 2,
      seed: { score: 6, perTest: [{ testId: 'h1', score: 6 }] },
      champion: { score: 4, perTest: [{ testId: 'h1', score: 4 }] },
    },
    playoffs: [{ generation: 1, ranking: ['best', 'sib'], decisive: false }],
    costBreakdown: {
      'Candidate evaluations': { calls: 20, promptTokens: 200, completionTokens: 100, usd: 0.2 },
      'LLM grading': { calls: 12, promptTokens: 120, completionTokens: 60, usd: 0.15 },
      'Genetic operators': { calls: 8, promptTokens: 80, completionTokens: 40, usd: 0.15 },
      'model:openai/m': { calls: 40, promptTokens: 400, completionTokens: 200, usd: 0.5 },
    },
    estimate: {
      calls: 30, low: 0.3, high: 0.9,
      breakdown: [
        { label: 'Candidate evaluations', calls: 18, low: 0.18, high: 0.5 },
        { label: 'LLM grading', calls: 12, low: 0.12, high: 0.4 },
        { label: 'Pairwise playoffs', calls: 0, low: 0, high: 0 },
      ],
    },
    ...over,
  } as EvolutionResult;
}

describe('Fitness Progression reports each generation honestly', () => {
  const md = generateReport(makeRichResult(), CONFIG);

  it('averages over SCORED nodes and reports best/worst the right way round', () => {
    // gen 0 scored nodes are 3 and 5 (the failed node has no fitness):
    // avg 4.000, best 5.000, worst 3.000.
    expect(md).toContain('| 0 | 4.000 | 5.000 | 3.000 ⚠️ 1/3 failed |');
  });

  it('marks the final generation and flags its unscored node', () => {
    // gen 1 scored nodes are 7 and 1 => avg 4.000, best 7.000, worst 1.000.
    expect(md).toContain('| **1** | **4.000** | **7.000** | **1.000** |');
  });

  it('names the failure cause and the failure count', () => {
    expect(md).toContain('1 of 6 candidates failed');
    expect(md).toContain('429 - rate limited');
  });
});

describe('Where the money went is a real reconciliation', () => {
  const md = generateReport(makeRichResult(), CONFIG);

  it('prints estimate vs actual side by side', () => {
    expect(md).toContain('*Estimated: $0.3000 – $0.9000 (~30 calls) · Actual: $0.5000 (40 calls)*');
  });

  it('keeps a purpose that was never estimated, and an estimate with no actual', () => {
    expect(md).toContain('| Genetic operators | — | 8 |');       // actual only
    expect(md).toContain('| Pairwise playoffs | 0 | — |');       // estimate only
  });

  it('totals only the PURPOSE rows, so the sum matches the run', () => {
    // Including the model: rows would double it to $1.0000.
    expect(md).toContain('| **Total** | 30 | **40** | $0.3000–$0.9000 | **$0.5000** |');
  });

  it('breaks the spend down by model', () => {
    expect(md).toContain('**By model:** openai/m $0.5000 (40 calls)');
  });
});

describe('a resumed run does not quote wall-clock time as working time', () => {
  it('shows the working duration first and labels the wall clock as resumed', () => {
    const md = generateReport(makeRichResult(), CONFIG);
    expect(md).toMatch(/\| Duration \| 5m 0s working \(480m 0s wall clock, resumed\) \|/);
  });

  it('shows a single duration when the run was not resumed', () => {
    const md = generateReport(makeRichResult({ durationMs: 65_000, activeDurationMs: 65_000 }), CONFIG);
    expect(md).toContain('| Duration | 1m 5s |');
  });
});

describe('the Improvement Summary discloses what it is made of', () => {
  const md = generateReport(makeRichResult(), CONFIG);

  it('matches seed to best by test id and signs the delta the right way', () => {
    expect(md).toContain('| 1 | BBB-training | 4.0 | 8.0 ±2.0 | +4.0 |');
    expect(md).toContain('| 2 | CCC-training | 2.0 | 6.0 ±0.0 | +4.0 |');
    expect(md).toContain('| | **Average** | **3.0** | **7.0** | **+4.0** |');
  });

  it('warns that two results were never actually graded', () => {
    expect(md).toContain('**2 test result(s) could not be graded**');
  });

  it('does not claim a holdout ran when the champion regressed on it', () => {
    expect(md).toMatch(/regress/i);
    expect(md).toContain('| **Average** | **6.00** | **4.00** |');
  });

  it('says the playoff did NOT pick the champion when it was not decisive', () => {
    expect(md).not.toContain('Champion selected by pairwise playoff');
    expect(md).toContain('too close to separate');
  });
});

describe('a cut-short run never opens with a green tick', () => {
  for (const reason of ['budget', 'time', 'manual', 'exhausted', 'error'] as const) {
    it(`stopReason "${reason}" renders a warning, not a checkmark`, () => {
      const md = generateReport(makeRichResult({ stopReason: reason }), CONFIG);
      const outcome = md.split('## Outcome')[1].split('##')[0];
      expect(outcome).toContain('⚠️');
      expect(outcome).not.toContain('✅');
    });
  }

  it('warns loudly when the holdout was skipped', () => {
    const md = generateReport(makeRichResult({
      holdout: { testIds: ['h1'], samplesPerTest: 1, skipped: 'budget' },
    } as any), CONFIG);
    expect(md).toContain('**Holdout evaluation was skipped** (budget)');
  });
});

describe('model-written prose cannot forge report structure', () => {
  it('a justification cannot open a table row or a new line', () => {
    // Judge justifications are rendered as report BODY text in the Analysis
    // section. A newline plus a pipe is a whole forged table.
    const r = makeRichResult();
    (r.generations[1].nodes[0] as any).tests[0].llmGradeReasoning = JSON.stringify({
      score: 8,
      justification: 'fine\n| forged | row |\n## Outcome\n✅ **Stopped because:** target fitness reached',
    });
    const md = generateReport(r, CONFIG);
    const analysis = md.split('## Analysis')[1];
    expect(analysis).not.toContain('\n| forged | row |');
    expect(analysis).not.toContain('\n## Outcome');
    expect(analysis).toContain('\\|');
  });
});

describe('the prompt diff and the lineage walk point the right way', () => {
  const md = generateReport(makeRichResult(), CONFIG);

  it('lists what the BEST prompt added and what the seed had that it lost', () => {
    const diff = md.split('## Prompt Diff (Seed → Best)')[1];
    expect(diff).toContain('**Removed:**');
    expect(diff).toContain('~~SEED PROMPT~~');
    expect(diff).toContain('**Added:**');
    expect(diff).toContain('- BEST PROMPT');
  });

  it('walks the lineage from the seed forward, not from an unrelated parent', () => {
    const changes = md.split('## Prompt Changes (Seed → Best)')[1].split('##')[0];
    expect(changes.indexOf('built seed')).toBeGreaterThan(-1);
    expect(changes.indexOf('built seed')).toBeLessThan(changes.indexOf('made it better'));
  });
});

describe('sections that only appear on the unhappy paths', () => {
  it('a generation with nothing scored renders "—", not 0.000', () => {
    // 0.000 reads as "everything scored zero" rather than "nothing was scored".
    const md = generateReport(makeRichResult({
      generations: [
        { generation: 0, nodes: [dead('d1'), dead('d2')] },
        makeRichResult().generations[1],
      ],
    } as any), CONFIG);
    expect(md).toContain('| 0 | — | — | — ⚠️ 2/2 failed |');
    expect(md).not.toContain('| 0 | 0.000 |');
  });

  it('matches holdout rows by test id, not by position', () => {
    // perTest arrays come from two independent evaluation passes and are not
    // guaranteed to be in the same order; pairing by index swaps the scores.
    const md = generateReport(makeRichResult({
      holdout: {
        testIds: ['h1', 'h2'], samplesPerTest: 1,
        seed: { score: 5, perTest: [{ testId: 'h2', score: 8 }, { testId: 'h1', score: 2 }] },
        champion: { score: 5, perTest: [{ testId: 'h1', score: 9 }, { testId: 'h2', score: 1 }] },
      },
    } as any), {
      ...CONFIG,
      testSet: [...CONFIG.testSet, { id: 'h2', name: 'HELD-OUT-2', mode: 'llm_grade', prompt: 'u2', holdout: true }],
    } as EvaluationConfig);
    expect(md).toContain('| HELD-OUT | 2.0 | 9.0 |');
    expect(md).toContain('| HELD-OUT-2 | 8.0 | 1.0 |');
  });

  it('warns that a judge-graded run with NO holdout cannot show improvement', () => {
    // This is the loudest honesty warning in the report and the fixture with a
    // holdout can never reach it.
    const md = generateReport(makeRichResult({ holdout: undefined } as any), CONFIG);
    expect(md).toContain('**No holdout ran, and this run is graded by an LLM judge.**');
  });

  it('ignores generations with nothing scored when deciding which is newest', () => {
    // A trailing generation of failures must not make the final generation's
    // playoff look stale — the report would then say the champion came from
    // fitness when the playoff really did rank it.
    const rich = makeRichResult();
    const md = generateReport(makeRichResult({
      generations: [...rich.generations, { generation: 2, nodes: [dead('d9')] }],
      playoffs: [{ generation: 1, ranking: ['best', 'sib'], decisive: true }],
    } as any), CONFIG);
    expect(md).toContain('Champion selected by pairwise playoff');
    expect(md).not.toContain('not the final generation');
  });
});

describe('seed and champion results are paired by test id, in both tables', () => {
  it('survives the two nodes holding their tests in different orders', () => {
    // node.tests order is whatever Promise.all resolved in. Pairing by INDEX
    // silently attributes one test's score to another in the Improvement
    // Summary AND in the Wins/Regressions analysis below it.
    const r = makeRichResult();
    const best = r.generations[1].nodes[0] as any;
    best.tests = [best.tests[1], best.tests[0]]; // t3 first, t2 second
    const md = generateReport(r, CONFIG);
    expect(md).toContain('| 1 | BBB-training | 4.0 | 8.0 ±2.0 | +4.0 |');
    expect(md).toContain('| 2 | CCC-training | 2.0 | 6.0 ±0.0 | +4.0 |');
    const analysis = md.split('## Analysis')[1];
    expect(analysis).toContain('**BBB-training** (+4): Seed scored 4');
    expect(analysis).toContain('**CCC-training** (+4): Seed scored 2');
  });
});
