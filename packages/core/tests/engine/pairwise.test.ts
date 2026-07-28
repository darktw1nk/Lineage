import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { runPairwisePlayoff } from '../../src/engine/pairwise.js';
import type { CandidateNode, TestCase, EvaluationConfig } from '../../src/types.js';

// Scripted judge: each scenario sets `verdictFn`.
let verdictFn: (outputA: string, outputB: string) => 'A' | 'B' | 'tie';
let judgeCalls = 0;

function registerJudge(wrap: (json: string) => string = s => s) {
  registerProvider({
    adapter: {
      name: 'fakejudge',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        judgeCalls++;
        const a = opts.prompt.match(/OUTPUT A: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
        const b = opts.prompt.match(/OUTPUT B: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
        const winner = verdictFn(a, b);
        return {
          output: wrap(JSON.stringify({ winner, reason: 'scripted' })),
          promptTokens: 5, completionTokens: 3, latencyMs: 1, usd: 0.001,
        };
      },
    } as any,
  });
}

const test1: TestCase = { id: 't1', name: 't1', mode: 'llm_grade', prompt: 'INPUT', expected: 'REF' } as TestCase;

function contender(id: string, fitness: number, output: string): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished',
    prompt: 'p-' + id,
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [],
    metrics: { fitness, quality: fitness },
    tests: [{ testId: 't1', passed: true, score: fitness, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: output }],
  } as unknown as CandidateNode;
}

const config = {
  serviceModel: { provider: 'fakejudge', model: 'j1' },
  serviceModelMaxTokens: 100, retries: 1,
  targets: {},
} as unknown as EvaluationConfig;

let accrued: Array<[number, number, number]>;
const accrue = (usd: number, pt: number, ct: number) => { accrued.push([usd, pt, ct]); };

beforeEach(() => { resetRegistry(); judgeCalls = 0; accrued = []; });

describe('runPairwisePlayoff', () => {
  it('agreement in both orders gives the winner a full point', async () => {
    registerJudge();
    verdictFn = (a, b) => (a.includes('GOOD') ? 'A' : b.includes('GOOD') ? 'B' : 'tie');
    const nodes = [contender('n1', 9, 'GOOD output'), contender('n2', 9.5, 'plain output')];
    const result = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(result!.ranking[0]).toBe('n1'); // playoff beats higher fitness
    expect(result!.points['n1']).toBe(1);
    expect(result!.points['n2']).toBe(0);
    expect(result!.matches).toBe(2); // one pair x one test x two orders
    expect(accrued).toHaveLength(2); // accrue once per judge call
    expect(accrued[0]).toEqual([0.001, 5, 3]);
  });

  it('a position-biased judge (always picks first shown) yields a tie', async () => {
    registerJudge();
    verdictFn = () => 'A'; // always the first-presented output
    const nodes = [contender('n1', 9, 'x'), contender('n2', 8, 'y')];
    const result = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(result!.points['n1']).toBe(0.5);
    expect(result!.points['n2']).toBe(0.5);
    expect(result!.ranking[0]).toBe('n1'); // fitness tiebreak
  });

  it('parses fenced verdict JSON and treats junk as tie', async () => {
    registerJudge(s => '```json\n' + s + '\n```');
    verdictFn = (a) => (a.includes('GOOD') ? 'A' : 'B');
    const nodes = [contender('n1', 9, 'GOOD'), contender('n2', 8, 'bad')];
    const fenced = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(fenced!.points['n1']).toBe(1);

    resetRegistry();
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async () => ({ output: 'NOT JSON AT ALL', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }) } as any });
    const junk = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(junk!.points['n1']).toBe(0.5); // all verdicts unparseable -> ties
    expect(junk!.points['n2']).toBe(0.5);
  });

  it('recovers verdicts from prose and embedded JSON (real flash-lite failure modes)', async () => {
    // Observed live: judges sometimes answer "OUTPUT A is better because..." despite
    // the JSON-only instruction, or wrap the JSON in prose. These must not become ties.
    const outputs = [
      'Output A is better because it more effectively removes the negative sentiment.',
      'OUTPUT A is better because it provides more varied options.',
    ];
    let call = 0;
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async () => ({ output: outputs[call++ % outputs.length], promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }) } as any });
    const nodes = [contender('n1', 9, 'x'), contender('n2', 8, 'y')];
    // Both orders say "A is better" -> first-presented wins each call -> disagreement -> 0.5/0.5
    const prose = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(prose!.points['n1']).toBe(0.5); // parsed as 'A'/'A' (position-biased), NOT tie-by-parse-failure

    resetRegistry();
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async () => ({ output: 'Sure! Here is my verdict: {"winner": "B", "reason": "clearer"} Hope that helps.', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }) } as any });
    const embedded = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    // 'B' in both orders -> disagreement (maps to different nodes) -> 0.5/0.5; the point
    // is it parsed as a verdict. Verify via a judge that names the winner consistently:
    expect(embedded!.points['n1']).toBe(0.5);
    expect(embedded!.points['n2']).toBe(0.5);

    resetRegistry();
    let embCall = 0;
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const a = opts.prompt.match(/OUTPUT A: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
        const winner = a.includes('GOOD') ? 'A' : 'B';
        embCall++;
        return { output: `Verdict follows. {"winner": "${winner}", "reason": "r"}`, promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      } } as any });
    const good = [contender('g1', 9, 'GOOD'), contender('g2', 8, 'meh')];
    const consistent = await runPairwisePlayoff({ contenders: good, tests: [test1], config, accrue });
    expect(embCall).toBe(2);
    expect(consistent!.points['g1']).toBe(1); // embedded JSON parsed in both orders -> full point
  });

  it('skips pair-tests where a contender lacks outputText', async () => {
    registerJudge();
    verdictFn = () => 'A';
    const noOutput = contender('n2', 8, '');
    (noOutput.tests![0] as any).outputText = undefined;
    const result = await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x'), noOutput], tests: [test1], config, accrue });
    expect(result!.matches).toBe(0);
    expect(result!.points['n1']).toBe(0);
    expect(result!.ranking[0]).toBe('n1'); // fitness order preserved
  });

  it('shouldAbort between pairs abandons remaining matches', async () => {
    registerJudge();
    verdictFn = () => 'tie';
    let aborted = false;
    const nodes = [contender('n1', 9, 'a'), contender('n2', 8, 'b'), contender('n3', 7, 'c')]; // 3 pairs
    const result = await runPairwisePlayoff({
      contenders: nodes, tests: [test1], config, accrue,
      shouldAbort: () => { const v = aborted; aborted = true; return v; }, // false for pair 1, true after
    });
    expect(result!.matches).toBe(2); // only the first pair ran (2 orders)
  });

  it('a throwing judge counts the call as a tie and never crashes', async () => {
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async () => { throw new Error('judge down'); } } as any });
    const nodes = [contender('n1', 9, 'x'), contender('n2', 8, 'y')];
    const result = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(result!.points['n1']).toBe(0.5);
    expect(result!.points['n2']).toBe(0.5);
    expect(result!.matches).toBe(2); // failed calls still count as matches
    expect(accrued).toHaveLength(0); // nothing accrued for failed calls
  });

  it('returns null for fewer than 2 contenders or no tests', async () => {
    registerJudge();
    verdictFn = () => 'tie';
    expect(await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x')], tests: [test1], config, accrue })).toBeNull();
    expect(await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x'), contender('n2', 8, 'y')], tests: [], config, accrue })).toBeNull();
  });
});
