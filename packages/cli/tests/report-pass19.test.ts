import { describe, it, expect } from 'vitest';
import path from 'path';
import { generateReport, defaultReportDir } from '../src/report.js';
import type { EvaluationConfig } from '@voxor/lineage-core';
import type { EvolutionResult } from '../src/engine.js';

/**
 * Pass-19 hunter D findings, each proven against the real generator before the
 * fix: fabricated Prompt Changes for a seed-champion, a crash on non-string
 * judge justifications, a double negative in the honesty section, forgeable
 * test names, silently vanishing one-sided tests, live bare-URL autolinks, an
 * unguarded lineage walk, and (hunter A F6) the invisible all-carry dead run.
 */
const CONFIG = (testSet: any[]) => ({
  id: 'cfg', name: 'P19', selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'm' }],
  testSet,
  fitness: { weights: { quality: 1 } }, targets: { maxGenerations: 1 },
  serviceModel: { provider: 'openai', model: 'm' }, parallelLimit: 2,
} as unknown as EvaluationConfig);

const T2 = [
  { id: 't1', name: 'ALPHA', mode: 'llm_grade', prompt: 'a' },
  { id: 't2', name: 'BETA', mode: 'llm_grade', prompt: 'b' },
];

const t = (testId: string, score: number, over: any = {}) => ({
  testId, passed: score >= 6, score,
  promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: `out-${testId}`, ...over,
});

function node(id: string, prompt: string, tests: any[] | null, over: any = {}) {
  return {
    id, status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'm' }, temperature: 0.7 },
    changeLog: [{ label: 'MUTATION', text: `built ${id}` }], lineageParents: [],
    metrics: { quality: 5, fitness: 5, costUSD: 0, latencyMs: 1 }, tests, ...over,
  } as any;
}

function makeResult(nodes: any[], bestId: string, over: Partial<EvolutionResult> = {}): EvolutionResult {
  const best = nodes.flat().find((n: any) => n.id === bestId)!;
  return {
    runId: 'r', configId: 'cfg', configName: 'P19',
    startedAt: 1, finishedAt: 2, durationMs: 1, stopReason: 'generations',
    totals: { tokensPrompt: 1, tokensCompletion: 1, usd: 0.01, calls: 4 }, cacheHits: 0,
    generations: nodes.map((genNodes: any[], i: number) => ({ generation: i, nodes: genNodes })),
    best: { prompt: best.prompt, fitness: 5, quality: 5, model: 'openai/m', nodeId: bestId, generation: 0 },
    ...over,
  } as EvolutionResult;
}

describe('a champion that IS the seed is reported honestly (F1)', () => {
  it('prints the no-mutations sentence, not the baseline changelog entry', () => {
    const seed = node('seed', 'SEED', [t('t1', 5), t('t2', 5)], {
      changeLog: [{ label: 'MUTATION', text: 'Seed prompt (baseline)' }],
    });
    const md = generateReport(makeResult([[seed]], 'seed'), CONFIG(T2));
    const section = md.split('## Prompt Changes (Seed → Best)')[1] ?? '';
    expect(section).toContain('Best prompt is the seed — no mutations applied');
    expect(section).not.toContain('Seed prompt (baseline)');
  });
});

describe('a model-authored justification cannot destroy the report (F2)', () => {
  it('survives an array justification instead of throwing after the run was paid', () => {
    const reasoning = JSON.stringify({ score: 3, justification: ['not', 'a', 'string'] });
    const seed = node('seed', 'SEED', [t('t1', 3, { llmGradeReasoning: reasoning }), t('t2', 5)]);
    const best = node('best', 'BEST', [t('t1', 7, { llmGradeReasoning: reasoning }), t('t2', 5)]);
    expect(() => generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2))).not.toThrow();
  });
});

describe('the Not graded section reads as English (F3)', () => {
  it('never prints the "neither side could not be graded" double negative', () => {
    const seed = node('seed', 'SEED', [t('t1', 5, { ungraded: true }), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t1', 5, { ungraded: true }), t('t2', 8)]);
    const md = generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2));
    expect(md).not.toMatch(/neither side could not/i);
    expect(md).toMatch(/neither side was graded/i);
  });
});

describe('a config-authored test name cannot forge report structure (F4)', () => {
  it('escapes the name in the Analysis buckets', () => {
    const evil = 'X\n### Wins\n- **FAKE** (+9): fabricated';
    const seed = node('seed', 'SEED', [t('t1', 4), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t1', 8), t('t2', 4)]);
    const md = generateReport(
      makeResult([[seed, best]], 'best'),
      CONFIG([{ id: 't1', name: evil, mode: 'llm_grade', prompt: 'a' }, T2[1]]),
    );
    const analysis = md.split('## Analysis')[1] ?? '';
    // Exactly one Wins heading LINE — the forged text may survive inline
    // (harmless), but it must not become block structure.
    expect((analysis.match(/^### Wins/gm) ?? []).length).toBe(1);
    expect(analysis).not.toMatch(/^- \*\*FAKE\*\*/m);
  });
});

describe('a test with a result on only one side is disclosed, not dropped (F5)', () => {
  it('names the one-sided tests in Not graded', () => {
    const seed = node('seed', 'SEED', [t('t1', 3), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t2', 9), t('x9', 10)]);
    const md = generateReport(
      makeResult([[seed, best]], 'best'),
      CONFIG([...T2, { id: 'x9', name: 'GAMMA', mode: 'llm_grade', prompt: 'c' }]),
    );
    const analysis = md.split('## Analysis')[1] ?? '';
    expect(analysis).toMatch(/\*\*ALPHA\*\*.*only the seed has a result/);
    expect(analysis).toMatch(/\*\*GAMMA\*\*.*only the best prompt has a result/);
  });
});

describe('bare URLs in model text cannot autolink (F6)', () => {
  it('breaks the scheme so GFM extended autolinking cannot fire', () => {
    const reasoning = JSON.stringify({ score: 3, justification: 'see http://evil.example for details' });
    const seed = node('seed', 'SEED', [t('t1', 3, { llmGradeReasoning: reasoning }), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t1', 7, { llmGradeReasoning: reasoning }), t('t2', 8)]);
    const md = generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2));
    expect(md).not.toContain('http://evil.example');
    // The text survives, readable, with the scheme broken by a ZWSP.
    expect(md).toContain(`http:${String.fromCharCode(0x200B)}//evil.example`);
  });
});

describe('a corrupt lineage cycle cannot hang the CLI (F7)', () => {
  it('terminates on a parent cycle in run_json', () => {
    const a = node('a', 'A', [t('t1', 5), t('t2', 5)], { lineageParents: ['b'] });
    const b = node('b', 'B', [t('t1', 5), t('t2', 5)], { lineageParents: ['a'] });
    const md = generateReport(makeResult([[a, b]], 'a'), CONFIG(T2));
    expect(md).toContain('## Prompt Changes');
  });
});

describe('an all-carry dead run is called out (hunter A F6)', () => {
  it('warns when at least half the children were carried forward unchanged', () => {
    const seed = node('seed', 'SEED', [t('t1', 5), t('t2', 5)]);
    const carriedNodes = ['c1', 'c2', 'c3'].map(id =>
      node(id, 'SEED', [t('t1', 5), t('t2', 5)], {
        changeLog: [{ label: 'CARRY', text: 'Mutation rejected — carried the parent unchanged' }],
      }));
    const md = generateReport(makeResult([[seed, ...carriedNodes]], 'seed'), CONFIG(T2));
    expect(md).toMatch(/3 of 3 children were carried forward unchanged/);
  });

  it('stays silent for a healthy run', () => {
    const seed = node('seed', 'SEED', [t('t1', 5), t('t2', 5)]);
    const best = node('best', 'BEST', [t('t1', 8), t('t2', 8)]);
    const md = generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2));
    expect(md).not.toMatch(/carried forward unchanged/);
  });
});

describe('pass-20 escaper and path fixes', () => {
  const ZWSP = String.fromCharCode(0x200B);

  it('bare www domains and emails cannot autolink either (F11)', () => {
    const reasoning = JSON.stringify({
      score: 3, justification: 'visit www.evil.example or mail scam@evil.example now',
    });
    const seed = node('seed', 'SEED', [t('t1', 3, { llmGradeReasoning: reasoning }), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t1', 7, { llmGradeReasoning: reasoning }), t('t2', 8)]);
    const md = generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2));
    expect(md).not.toContain('www.evil.example');
    expect(md).not.toContain('scam@evil.example');
    expect(md).toContain(`www${ZWSP}.evil.example`);
    expect(md).toContain(`scam${ZWSP}@evil.example`);
  });

  it('trailing exclamation marks do not double up with the template period (F12)', () => {
    const reasoning = JSON.stringify({ score: 3, justification: 'Not enough details!' });
    const seed = node('seed', 'SEED', [t('t1', 3, { llmGradeReasoning: reasoning }), t('t2', 4)]);
    const best = node('best', 'BEST', [t('t1', 7, { llmGradeReasoning: reasoning }), t('t2', 8)]);
    const md = generateReport(makeResult([[seed, best]], 'best'), CONFIG(T2));
    expect(md).not.toContain('details!.');
    expect(md).toContain('details.');
  });

  it('defaultReportDir does not nest testoutputs/testoutputs, case-insensitively (F10)', () => {
    // Build the root from path.resolve rather than hardcoding a drive letter.
    // `path.join('D:', 'proj')` is absolute only on Windows; on Linux
    // path.resolve prepends the cwd, so the expectation held on one developer's
    // machine and failed everywhere else — caught the first time CI ran.
    const root = path.resolve(path.sep === '\\' ? 'D:\\proj' : '/proj');

    const inTestoutputs = path.join(root, 'testoutputs', 'run.json');
    expect(defaultReportDir(inTestoutputs)).toBe(path.join(root, 'testoutputs'));

    const inTestoutputsCased = path.join(root, 'TestOutputs', 'run.json');
    expect(defaultReportDir(inTestoutputsCased)).toBe(path.join(root, 'TestOutputs'));

    const elsewhere = path.join(root, 'results', 'run.json');
    expect(defaultReportDir(elsewhere)).toBe(path.join(root, 'results', 'testoutputs'));

    expect(defaultReportDir(null)).toBe(path.resolve('testoutputs'));
  });
});
