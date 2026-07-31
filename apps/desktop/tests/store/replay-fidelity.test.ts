import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Gaps mutation testing found in evaluationStore.ts (hunt 13).
 *
 * subscribe-race.test.ts already carries a scar about this: its drain test
 * originally used `totals`, found that replacing an idempotent event proves
 * nothing, and switched to `node_created`. But `addNodeToEvaluation` was
 * SUBSEQUENTLY made idempotent too ("resume replays node_created for
 * checkpointed nodes — replace, never duplicate"), so the drain test is
 * vacuous again and deleting `pendingUpdates.delete(evalId)` survives.
 *
 * Every store mutator is idempotent by design, so proving the drain needs a
 * SEQUENCE: apply the buffered event, move the state past it, and check the
 * stale event cannot come back. That is also the failure that was measured —
 * a buffered `totals` rewinding 500 calls / $2.50 to 3 calls / $0.001.
 */
let handler: ((e: any, d: any) => void) | null = null;
const subscribeMock = vi.fn((_id: string, h: any) => { handler = h; return () => {}; });

vi.stubGlobal('window', {
  electronAPI: { eval: { subscribe: subscribeMock, get: vi.fn() } },
});

const { useEvaluationStore } = await import('../../src/store/evaluationStore');

const RUN = 'run-1';
const totals = (calls: number, usd: number) => ({ tokensPrompt: 0, tokensCompletion: 0, usd, calls });
const snapshot = () => ({
  id: RUN, configId: 'c', status: 'running', generations: [[]],
  totals: totals(0, 0), startedAt: 1,
} as any);

beforeEach(() => {
  handler = null;
  useEvaluationStore.setState({ evaluations: new Map(), subscriptions: new Map() } as any);
});

describe('the pending buffer is drained, not merely read', () => {
  it('a replayed event cannot come back and rewind later state', () => {
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);

    // Arrives before the entry exists, so it is buffered.
    handler!(null, { type: 'totals', totals: totals(3, 0.001), cacheHits: 0 });
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.totals.calls).toBe(3);

    // The run carries on. This is live state, strictly newer than the buffer.
    useEvaluationStore.getState().updateTotals(RUN, totals(500, 2.5), 0);

    // A second hydrate (re-open, poll refresh) must not resurrect the buffer.
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.totals.calls).toBe(500);
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.totals.usd).toBe(2.5);
  });
});

describe('the buffer replays in ARRIVAL order', () => {
  it('the last of two same-kind events wins, as it would live', () => {
    // The existing replay test buffers a `status` and a `stop` — different
    // fields, so reversing the replay changes nothing. Two events of the same
    // kind are what make order observable, and out-of-order replay is how a
    // finished run shows as still running.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);

    handler!(null, { type: 'totals', totals: totals(1, 0.01), cacheHits: 0 });
    handler!(null, { type: 'totals', totals: totals(9, 0.09), cacheHits: 0 });
    handler!(null, { type: 'status', status: 'running' });
    handler!(null, { type: 'status', status: 'finished' });

    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const after = useEvaluationStore.getState().evaluations.get(RUN)!;
    expect(after.totals.calls).toBe(9);
    expect(after.status).toBe('finished');
  });
});

describe('the cost_breakdown event is actually consumed', () => {
  it('breakdown, estimate and ungradedTests reach the run', () => {
    // The desktop once had ZERO readers for this event: fabricated placeholder
    // scores were shown as measurements with no disclosure at all, while the CLI
    // report warns loudly on the same data. Nothing asserts the handler exists,
    // so replacing its body with `break` survives.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    useEvaluationStore.getState().hydrate(RUN, snapshot());

    handler!(null, {
      type: 'cost_breakdown',
      breakdown: { grading: { calls: 4, promptTokens: 1, completionTokens: 1, usd: 0.02 } },
      estimate: { lowUSD: 1, highUSD: 2 },
      ungradedTests: 7,
    });

    const after = useEvaluationStore.getState().evaluations.get(RUN)! as any;
    expect(after.ungradedTests).toBe(7);
    expect(after.costBreakdown.grading.calls).toBe(4);
    expect(after.estimate.highUSD).toBe(2);
  });
});

describe('holdout state reaches a LIVE session, not only a reloaded one (pass 19)', () => {
  it('holdoutSkippedReason rides the cost_breakdown event to the run', async () => {
    // Pass 19, hunter C F1: the engine persisted the field but no IPC event
    // carried it, so the "holdout share rounded to zero" warning could only
    // ever appear after an app restart — never in the session where the user
    // could act on it.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    useEvaluationStore.getState().hydrate(RUN, snapshot());

    handler!(null, { type: 'cost_breakdown', breakdown: {}, holdoutSkippedReason: 'share-rounds-to-zero' });

    const after = useEvaluationStore.getState().evaluations.get(RUN)! as any;
    expect(after.holdoutSkippedReason).toBe('share-rounds-to-zero');

    const { holdoutTile } = await import('../../src/utils/holdoutTile');
    const tile = holdoutTile(after.holdout, after.holdoutSkippedReason)!;
    expect(tile).not.toBeNull();
    expect(tile.warn).toBe(true);
    expect(tile.value).toMatch(/not run/i);
  });

  it('a SKIPPED holdout_result renders its reason live', async () => {
    // Pass 19, hunter C F2 companion: a Stop mid-holdout now emits
    // holdout_result with skipped:'manual' instead of returning early —
    // the store and tile must show it in the same session.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    useEvaluationStore.getState().hydrate(RUN, snapshot());

    handler!(null, {
      type: 'holdout_result',
      holdout: { testIds: ['h1'], samplesPerTest: 1, champion: { score: 7.5, perTest: [{ testId: 'h1', score: 7.5 }] }, skipped: 'manual' },
    });

    const after = useEvaluationStore.getState().evaluations.get(RUN)! as any;
    const { holdoutTile } = await import('../../src/utils/holdoutTile');
    const tile = holdoutTile(after.holdout, after.holdoutSkippedReason)!;
    expect(tile.value).toContain('manual');
    expect(tile.warn).toBe(true);
  });
});

describe('hydrate keeps the LIVE node when both sides have the same id', () => {
  it('a DB snapshot does not rewind a node the live stream already advanced', () => {
    // The merge comment says "live wins: the snapshot is by definition the older
    // view", but no test collides the two — every case has disjoint ids or an
    // empty side. Making the snapshot win instead survives, and that is the
    // whole subscribe-then-await race the merge exists to fix: eval:get returns
    // a node still `running` while node_updated has already marked it finished.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);

    useEvaluationStore.getState().hydrate(RUN, snapshot());
    useEvaluationStore.getState().addNodeToEvaluation(RUN, {
      id: 'n1', generation: 0, status: 'finished', metrics: { fitness: 9 },
    } as any);

    // A snapshot taken BEFORE that update lands afterwards.
    useEvaluationStore.getState().hydrate(RUN, {
      ...snapshot(),
      generations: [[{ id: 'n1', generation: 0, status: 'running', metrics: { fitness: 0 } }]],
    } as any);

    const node = useEvaluationStore.getState().evaluations.get(RUN)!.generations[0][0] as any;
    expect(node.status).toBe('finished');
    expect(node.metrics.fitness).toBe(9);
  });
});
