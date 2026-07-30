import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every store mutator begins `const evaluation = get(evalId); if (!evaluation)
 * return state;`, and useEvaluation subscribes BEFORE awaiting eval:get — so
 * anything arriving in that window was silently dropped.
 *
 * Deterministic on the Resume path: onSelectEvaluation is a plain setState with
 * no wait, and a measured replay discarded 5 of 50 events including the run's
 * `status`. `status`, `stop`, `holdout_result` and `playoff_result` each fire
 * EXACTLY ONCE, at the end, so losing one means it never appears until restart.
 */
let handler: ((e: any, d: any) => void) | null = null;
const subscribeMock = vi.fn((_id: string, h: any) => { handler = h; return () => {}; });

vi.stubGlobal('window', {
  electronAPI: { eval: { subscribe: subscribeMock, get: vi.fn() } },
});

const { useEvaluationStore } = await import('../../src/store/evaluationStore');

const RUN = 'run-1';
const snapshot = () => ({
  id: RUN, configId: 'c', status: 'running', generations: [[]],
  totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
  startedAt: 1,
} as any);

beforeEach(() => {
  handler = null;
  useEvaluationStore.setState({ evaluations: new Map(), subscriptions: new Map() } as any);
});

describe('events arriving before hydrate are not lost', () => {
  it('replays a status/stop pair that landed during the eval:get await', () => {
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    expect(handler).toBeTruthy();

    // These arrive while eval:get is still in flight — no entry exists yet.
    handler!(null, { type: 'status', status: 'finished' });
    handler!(null, { type: 'stop', reason: 'budget' });

    // Nothing recorded yet, because there is nothing to record onto.
    expect(useEvaluationStore.getState().evaluations.get(RUN)).toBeUndefined();

    useEvaluationStore.getState().hydrate(RUN, snapshot());

    const after = useEvaluationStore.getState().evaluations.get(RUN)!;
    expect(after.status).toBe('finished');
    expect(after.stopReason).toBe('budget');
  });

  it('drains the buffer, so a re-hydrate cannot replay it again', () => {
    // The old version used a status event, which is IDEMPOTENT — it passed
    // whether or not the buffer was drained. Use a CUMULATIVE event instead, so
    // a second replay is visible.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    handler!(null, { type: 'totals', totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 1, calls: 7 } });
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const afterFirst = useEvaluationStore.getState().evaluations.get(RUN)!.totals;
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.totals).toEqual(afterFirst);
  });

  it('keeps the TERMINAL events when the buffer overflows', () => {
    // The cap kept the OLDEST and silently discarded everything after it — and
    // what arrives last is status/stop/holdout_result, each firing exactly once.
    // Reachable on Resume, where node_created replays for every node in one
    // tick before eval:get returns.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    for (let i = 0; i < 3000; i++) {
      handler!(null, { type: 'totals', totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: i } });
    }
    handler!(null, { type: 'status', status: 'finished' });
    handler!(null, { type: 'stop', reason: 'budget' });

    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const after = useEvaluationStore.getState().evaluations.get(RUN)!;
    expect(after.status).toBe('finished');
    expect(after.stopReason).toBe('budget');
  });

  it('forgets the buffer on unsubscribe, so it cannot rewind a fresh snapshot', () => {
    // A buffered `totals` survived unsubscribe and was replayed over the next
    // hydrate, rewinding a run's spend to a stale value.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    handler!(null, { type: 'totals', totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0.001, calls: 3 } });
    useEvaluationStore.getState().unsubscribe(RUN);

    useEvaluationStore.getState().subscribe(RUN);
    const fresh = { ...snapshot(), totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 2.5, calls: 500 } };
    useEvaluationStore.getState().hydrate(RUN, fresh as any);
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.totals.calls).toBe(500);
  });
});
