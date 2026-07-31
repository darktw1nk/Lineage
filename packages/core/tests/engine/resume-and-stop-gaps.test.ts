import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'k', set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';

/**
 * A mutation sweep proved eight defects in evaluator_v2 survive a green suite
 * because nothing drives RESUME or the end-of-run phases: dropping 'budget'
 * from SKIP_EXTRA_SPEND, the holdout carry-forward, the resume dedupe, and the
 * spend recovery restoring the cost breakdown. Each needs a run that is
 * checkpointed and then started again from that checkpoint — which no existing
 * test does.
 */
const USD = 0.001;
let candidateCalls = 0, judgeCalls = 0, holdoutCalls = 0;
let costContext = '';

function registerPricedAdapter() {
  registerProvider({ adapter: {
    name: 'priced',
    estimateTokens: () => ({ prompt: 10 }),
    call: async (opts: any) => {
      const isJudge = /Rubric|score/i.test(opts.prompt);
      if (isJudge) judgeCalls++; else candidateCalls++;
      if (costContext === 'holdout') holdoutCalls++;
      return {
        output: isJudge ? '{"score": 8, "justification": "ok"}' : 'ANSWER',
        promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD,
      };
    },
  } as any });
}

function makeConfig(over: any = {}) {
  return {
    id: 'res-cfg', name: 'resume gaps',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 2, generationSize: 2, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'priced', model: 'm1' }],
    testSet: [
      { id: 't1', name: 'train', mode: 'llm_grade', prompt: 'A' },
      { id: 'h1', name: 'held', mode: 'llm_grade', prompt: 'H', holdout: true },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'priced', model: 'm1' },
    parallelLimit: 2, samplesPerTest: 1,
    serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

/** Run to completion against a scratch DB, returning the checkpoint. */
async function runOnce(config: any, dbPath: string, runId: string, seedRun?: any) {
  await initializeDatabase(dbPath);
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM evaluation_configs WHERE id = ?').get(config.id);
  if (!existing) {
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
  }
  const runRow: any = seedRun ?? {
    id: runId, configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [], cacheHits: 0, version: '1.0',
  };
  const already = db.prepare('SELECT id FROM evaluation_runs WHERE id = ?').get(runRow.id);
  if (!already) {
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(runRow.id, runRow.configId, runRow.startedAt, JSON.stringify(runRow), runRow.version);
  }

  const done = new Promise<void>(res => setSendUpdate((_id, d: any) => {
    if (d.type === 'status' && d.status === 'finished') res();
  }));
  await startEvaluation(runRow.id, config, runRow);
  await done;
  const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(runRow.id) as any).run_json);
  closeDatabase();
  setSendUpdate(() => {});
  return final;
}

const tmp = () => path.join(os.tmpdir(), `pe-res-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

beforeEach(() => {
  resetRegistry();
  candidateCalls = judgeCalls = holdoutCalls = 0;
  costContext = '';
});

describe('a completed holdout is not re-billed on resume', () => {
  it('resuming a finished run re-evaluates nothing', async () => {
    registerPricedAdapter();
    const db = tmp();
    const first = await runOnce(makeConfig(), db, 'res-1');
    expect(first.holdout?.seed).toBeDefined();
    expect(first.holdout?.champion).toBeDefined();
    const callsAfterFirst = candidateCalls + judgeCalls;

    // Feed the SAME checkpoint back in. A finished run must refuse outright
    // rather than silently re-running and re-paying for the holdout.
    candidateCalls = judgeCalls = 0;
    await expect(runOnce(makeConfig(), db, 'res-1', first)).rejects.toThrow(/already finished/i);
    expect(candidateCalls + judgeCalls).toBe(0);
    expect(callsAfterFirst).toBeGreaterThan(0);

    fs.rmSync(db, { force: true });
  }, 120000);
});

describe('an interrupted run resumes without repeating settled work', () => {
  it('carries forward the spend it had already paid', async () => {
    registerPricedAdapter();
    const db = tmp();
    // No holdout in this scenario on purpose: with every node already finished,
    // a correct resume has NOTHING left to do, so the honest assertion is ZERO
    // new calls. `resumeCalls < firstLegCalls` was too loose — a mutant that
    // re-evaluates every finished node still made fewer calls than the whole
    // first leg and passed.
    const noHoldout = makeConfig({
      testSet: [{ id: 't1', name: 'train', mode: 'llm_grade', prompt: 'A' }],
    });
    const first = await runOnce(noHoldout, db, 'res-2');
    const spentFirst = first.totals.usd;
    expect(spentFirst).toBeGreaterThan(0);

    // Rewind to an INTERRUPTED state: keep the generations and the spend, drop
    // the terminal markers. This is what a crash mid-run leaves behind.
    const interrupted = {
      ...first,
      status: 'running',
      stopReason: undefined,
      finishedAt: undefined,
      holdout: undefined,
    };
    candidateCalls = judgeCalls = 0;
    const second = await runOnce(noHoldout, db, 'res-2', interrupted);

    // Spend only ever grows: a resume must not reset the meter, which is what
    // re-arms budgetUSD and lets a restart loop spend without limit.
    expect(second.totals.usd).toBeGreaterThanOrEqual(spentFirst);

    // The nodes it already finished are not re-evaluated. `generations.length
    // >= previous` CANNOT detect this — the count never decreases, so a mutant
    // that re-evaluates and re-bills every finished node passed (measured: the
    // resume leg went 4 -> 7 paid calls and spend $0.011 -> $0.014). Count the
    // calls the resume actually made instead; the counters were reset above and
    // then never asserted, which is the same dead-counter family as the
    // `while (done < issued)` bug.
    expect(candidateCalls + judgeCalls).toBe(0);

    fs.rmSync(db, { force: true });
  }, 120000);
});

describe('a budget stop does not fund the end-of-run phases', () => {
  // NOTE ON COVERAGE, verified by mutation: dropping 'budget' from
  // SKIP_EXTRA_SPEND does NOT fail this test, and that is correct — the mutant
  // is EQUIVALENT. reserveCall is a settled-spend gate, so stopReason 'budget'
  // always implies totals >= budgetUSD, which means the holdout's own budget
  // gate fires anyway. This pins the OBSERVABLE contract (recorded as skipped,
  // nothing paid); it does not pin that particular set membership, and claiming
  // otherwise would be the same false guarantee this file exists to avoid.
  it('records the holdout as skipped rather than paying for it', async () => {
    registerPricedAdapter();
    const db = tmp();
    // A cap small enough that the population fill alone crosses it.
    const final = await runOnce(
      makeConfig({ targets: { maxGenerations: 1, budgetUSD: 2 * USD } }), db, 'res-3');

    expect(final.stopReason).toBe('budget');
    // The holdout must be RECORDED (so the report can say why) and must not
    // have been evaluated.
    expect(final.holdout?.skipped).toBeDefined();
    expect(final.holdout?.seed).toBeUndefined();
    expect(final.holdout?.champion).toBeUndefined();

    fs.rmSync(db, { force: true });
  }, 120000);
});

/**
 * END TO END, not against a hand-built map.
 *
 * The unit tests for reconcileUngradedCount passed a Map production could not
 * construct: `nodeId` was added to runSingleSample but never to its only
 * caller, so the guard was always false and the Map was always empty. The
 * arithmetic was pinned and the wiring was dead — the same failure as testing a
 * pasted copy, one level further out.
 */
describe('a run that could not be graded says so, in the database', () => {
  it('persists a non-zero count when the judge is unreadable', async () => {
    // The case the whole saga is about: judge replies unparseable, so the
    // scores are placeholders. The DB row is what --resume and the desktop read.
    registerProvider({ adapter: {
      name: 'priced',
      estimateTokens: () => ({ prompt: 10 }),
      call: async (opts: any) => {
        const isJudge = /Rubric|score/i.test(opts.prompt);
        if (isJudge) judgeCalls++; else candidateCalls++;
        return {
          output: isJudge ? 'I think that was pretty good, honestly.' : 'ANSWER',
          promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD,
        };
      },
    } as any });

    const db = tmp();
    const final = await runOnce(makeConfig({
      population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
      testSet: [{ id: 't1', name: 'train', mode: 'llm_grade', prompt: 'A' }],
      operators: { mutationShare: 0, crossoverShare: 0 },
    }), db, 'ung-1');

    expect(final.ungradedTests).toBeGreaterThan(0);
    // And in the SAME units as the rows: one test, one ungraded row, count 1.
    const leaves = final.generations.flat()
      .reduce((n: number, node: any) => n + (node.tests ?? []).filter((t: any) => t.ungraded).length, 0);
    expect(final.ungradedTests).toBe(leaves);

    fs.rmSync(db, { force: true });
  }, 120000);

  it('keeps the count when the node FAILS before producing any tests', async () => {
    // THE case the tally exists for, and the one the previous test cannot see:
    // processNode assigns `node.tests` only on success, so a node that throws
    // mid-evaluation leaves nothing for the leaf sweep — while a sibling test
    // has already recorded a real grading failure. Without the nodeId plumbing
    // the count is silently 0, which is exactly what shipped.
    let n = 0;
    registerProvider({ adapter: {
      name: 'priced',
      estimateTokens: () => ({ prompt: 10 }),
      call: async (opts: any) => {
        const isJudge = /Rubric|score/i.test(opts.prompt);
        if (isJudge) {
          judgeCalls++;
          return { output: 'prose, not a verdict', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: USD };
        }
        candidateCalls++;
        // First candidate call answers; the second throws, failing the node
        // AFTER the first test has already been graded (and ungraded).
        if (++n > 1) throw new Error('provider exploded');
        return { output: 'ANSWER', promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: USD };
      },
    } as any });

    const db = tmp();
    const final = await runOnce(makeConfig({
      population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
      testSet: [
        { id: 't1', name: 'a', mode: 'llm_grade', prompt: 'A' },
        { id: 't2', name: 'b', mode: 'llm_grade', prompt: 'B' },
      ],
      operators: { mutationShare: 0, crossoverShare: 0 },
    }), db, 'ung-2');

    const node: any = final.generations.flat()[0];
    expect(node.status).toBe('failed');
    expect(node.tests).toBeUndefined();
    // The grading failure that DID happen must survive into the durable record.
    expect(final.ungradedTests).toBeGreaterThan(0);

    fs.rmSync(db, { force: true });
  }, 120000);
});
