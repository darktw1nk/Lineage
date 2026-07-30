import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';

/**
 * Everything here scores a candidate. Mutation testing (pass 8) found the whole
 * group unprotected: the safety pass could be disabled, stability could be
 * disabled, an exact_match test with no `expected` could score 5 and PASS, an
 * unknown distanceMetric could score 10, node cost could ignore prompt tokens,
 * and the holdout baseline could quietly re-run the CHAMPION's prompt as the
 * "seed" — all with 595 tests green.
 */
let variantCounter = 0;
let judgeScore: number | string = 9;
let judgeRaw: string | null = null;
let latencyMs = 10;

function registerAdapter() {
  registerProvider({
    adapter: {
      name: 'score',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 100, completionTokens: 10, latencyMs, usd: 0 };
        const p: string = opts.prompt;
        if (p.includes('Guardrail:')) return { ...base, output: JSON.stringify({ score: 3, violations: ['x'] }) };
        if (p.includes('Rubric')) {
          return { ...base, output: judgeRaw ?? JSON.stringify({ score: judgeScore, justification: 'j' }) };
        }
        if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"t"}]' };
        if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: `VARIANT ${++variantCounter}` };
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(over: any = {}) {
  return {
    id: 'st-cfg', name: 'scoring truth',
    selection: { policy: 'topk', topK: 1 },
    operators: { mutationShare: 0, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'score', model: 'm' }],
    testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'SEED' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'score', model: 'm' },
    parallelLimit: 1, samplesPerTest: 1, serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

async function run(config: any, opts: { price?: { prompt: number; completion: number } } = {}) {
  const tmpDb = path.join(os.tmpdir(), `pe-st-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  if (opts.price) {
    db.prepare('INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k) VALUES (?, ?, ?, ?)')
      .run('score', 'm', opts.price.prompt, opts.price.completion);
  }
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const runRow: any = {
    id: 'st-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0',
  };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(runRow.id, runRow.configId, runRow.startedAt, JSON.stringify(runRow), runRow.version);

  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, d) => {
    events.push(d);
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(runRow.id, config, runRow);
  await done;
  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(runRow.id) as any).run_json);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}.lock`, { force: true });
  setSendUpdate(() => {});
  return { final, events, seedNode: final.generations[0][0] };
}

beforeEach(() => {
  resetRegistry(); variantCounter = 0; judgeScore = 9; judgeRaw = null; latencyMs = 10;
});

describe('optional fitness dimensions are actually measured', () => {
  it('runs the safety guardrail pass and stores its score on the node', async () => {
    // The whole safety branch could be replaced with `if (false)` and every
    // test stayed green: no test ever configures a guardrail end-to-end.
    registerAdapter();
    const { seedNode } = await run(makeConfig({
      fitness: { weights: { quality: 0.5, safety: 0.5 }, guardrails: ['must not swear'] },
    }));
    expect(seedNode.metrics.safety).toBe(3);       // the judge said 3
    expect(seedNode.metrics.fitness).toBeCloseTo(0.5 * 10 + 0.5 * 3, 5);
  }, 60000);

  it('computes stability from the samples it already paid for', async () => {
    // samplesPerTest 2 with one exact match and one miss = maximum disagreement
    // on a 0/10 scale, so stability must be well below 10 — and defined at all.
    let n = 0;
    registerProvider({
      adapter: {
        name: 'score', estimateTokens: () => ({ prompt: 1 }),
        call: async () => ({
          output: n++ % 2 === 0 ? 'SEED' : 'NOPE',
          promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0,
        }),
      } as any,
    });
    const { seedNode } = await run(makeConfig({
      samplesPerTest: 2,
      fitness: { weights: { quality: 0.5, stability: 0.5 } },
      testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'SEED',
                  grading: { strictZeroOnDeviation: true } }],
    }));
    expect(seedNode.metrics.stability).toBeDefined();
    expect(seedNode.metrics.stability).toBeLessThan(5);
    expect(seedNode.tests[0].samples).toEqual([10, 0]);
  }, 60000);
});

describe('a misconfigured test scores ZERO, never a plausible middle', () => {
  it('an exact_match test with no `expected` scores 0 and does not pass', async () => {
    // Scoring it 5 and marking it passed makes a broken test set look like a
    // mediocre prompt, and every candidate gets the same free 5.
    registerAdapter();
    const { seedNode } = await run(makeConfig({
      testSet: [{ id: 't1', name: 'no-expected', mode: 'exact_match', prompt: 'A' }],
    }));
    expect(seedNode.tests[0].score).toBe(0);
    expect(seedNode.tests[0].passed).toBe(false);
  }, 60000);

  it('an unknown distanceMetric scores 0, not a plausible middle', async () => {
    registerAdapter();
    const { seedNode } = await run(makeConfig({
      testSet: [{ id: 't1', name: 'bad-metric', mode: 'exact_match', prompt: 'A', expected: 'SEED',
                  grading: { distanceMetric: 'nonsense' } }],
    }));
    // Was 5.0 with no ungraded flag, so it counted fully in the quality mean:
    // a misspelt option granted every candidate a permanent free 5.0.
    expect(seedNode.tests[0].score).toBe(0);
    expect(seedNode.tests[0].passed).toBe(false);
  }, 60000);

  it('mean >= 7 is what makes a test "passed"', async () => {
    registerAdapter();
    judgeScore = 6;
    const { seedNode } = await run(makeConfig({
      testSet: [{ id: 't1', name: 'graded', mode: 'llm_grade', prompt: 'A' }],
    }));
    expect(seedNode.tests[0].score).toBe(6);
    expect(seedNode.tests[0].passed).toBe(false);
  }, 60000);
});

describe('node cost and latency are aggregated the way fitness assumes', () => {
  it('cost counts prompt tokens as well as completion tokens', async () => {
    // metrics.costUSD feeds the cost dimension directly. Dropping the prompt
    // half made every candidate look 10x cheaper than it is.
    registerAdapter();
    const { seedNode } = await run(
      makeConfig({ testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'SEED' }] }),
      { price: { prompt: 1, completion: 1 } }, // $1 per 1k either way
    );
    // one call: 100 prompt + 10 completion tokens
    expect(seedNode.metrics.costUSD).toBeCloseTo((100 + 10) / 1000, 9);
  }, 60000);

  it('node latency is the SUM across tests, per-test latency the MEAN across samples', async () => {
    registerAdapter();
    latencyMs = 40;
    const { seedNode } = await run(makeConfig({
      samplesPerTest: 2,
      testSet: [
        { id: 't1', name: 'a', mode: 'exact_match', prompt: 'A', expected: 'SEED' },
        { id: 't2', name: 'b', mode: 'exact_match', prompt: 'B', expected: 'SEED' },
      ],
    }));
    // Each test: mean of two 40ms samples = 40. Node: 40 + 40 = 80.
    expect(seedNode.tests[0].latencyMs).toBe(40);
    expect(seedNode.tests[1].latencyMs).toBe(40);
    expect(seedNode.metrics.latencyMs).toBe(80);
  }, 60000);
});

describe('the holdout measures the SEED against the champion', () => {
  it('re-runs the configured seed prompt, not the champion prompt, as the baseline', async () => {
    // "seed -> champion" is the only honest number the tool produces. Scoring
    // the champion twice makes every generalization delta exactly zero, which
    // reads as "no overfitting" rather than "not measured".
    registerAdapter();
    const { final } = await run(makeConfig({
      population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
      operators: { mutationShare: 1, crossoverShare: 0 },
      // The fitness test rewards the MUTATED prompt, so the champion is not the seed.
      testSet: [
        { id: 't1', name: 'train', mode: 'exact_match', prompt: 'A', expected: 'VARIANT 1',
          grading: { strictZeroOnDeviation: true } },
        { id: 'h1', name: 'held out', mode: 'exact_match', prompt: 'H', expected: 'SEED',
          grading: { strictZeroOnDeviation: true }, holdout: true },
      ],
    }));

    expect(final.holdout.champion.score).toBe(0); // champion is "VARIANT 1"
    expect(final.holdout.seed.score).toBe(10);    // baseline really is "SEED"
  }, 60000);
});

describe('a fabricated 5.0 is counted on the run', () => {
  it('records ungradedTests when the judge reply cannot be parsed', async () => {
    // fitness.ts flags the result `_ungraded` and report.ts renders a warning,
    // but the engine hop between them — incrementing run.ungradedTests and
    // putting it on the cost_breakdown event — had no test at all.
    registerAdapter();
    judgeRaw = 'I think this answer is quite good, honestly.';
    const { final, events } = await run(makeConfig({
      testSet: [
        { id: 't1', name: 'g1', mode: 'llm_grade', prompt: 'A' },
        { id: 't2', name: 'g2', mode: 'llm_grade', prompt: 'B' },
      ],
    }));
    expect(final.ungradedTests).toBe(2);
    const bd = events.find(e => e.type === 'cost_breakdown');
    expect(bd.ungradedTests).toBe(2);
  }, 60000);

  it('flags the LEAF, so quality can refuse to credit a placeholder', async () => {
    // The chain has four hops and only the two ENDS were pinned, so the middle
    // could be broken with the whole suite green. This is the hop that now
    // drives quality: runSingleSample sets `ungraded` on its own internal
    // return and evaluatePromptOnTests rebuilds the TestResult from scratch, so
    // deleting the copy silently restores the fabricated 5.0 to the mean.
    registerAdapter();
    judgeRaw = 'I think this answer is quite good, honestly.';
    const { seedNode } = await run(makeConfig({
      testSet: [{ id: 't1', name: 'g1', mode: 'llm_grade', prompt: 'A' }],
    }));

    expect(seedNode.tests[0].score).toBe(5);            // the placeholder itself
    expect((seedNode.tests[0] as any).ungraded).toBe(true);
    // ...and because the leaf says so, the placeholder earns nothing.
    expect(seedNode.metrics.quality).toBe(0);
  }, 60000);
});
