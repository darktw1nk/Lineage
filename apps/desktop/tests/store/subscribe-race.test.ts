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
    // `totals` is NOT cumulative — updateTotals does { ...evaluation, totals },
    // a replace — so using it here was exactly as idempotent as the `status`
    // event it replaced, and the mutation that removes the drain SURVIVED.
    // node_created appends, so a second replay is visible as a duplicate.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    handler!(null, { type: 'node_created', node: { id: 'n1', generation: 0, status: 'pending' } });
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const afterFirst = useEvaluationStore.getState().evaluations.get(RUN)!.generations.flat().length;
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const afterSecond = useEvaluationStore.getState().evaluations.get(RUN)!.generations.flat().length;
    expect(afterSecond).toBe(afterFirst);
  });

  it('keeps the TERMINAL events AND enforces the bound', () => {
    // The previous version never checked the bound — deleting the cap outright
    // left it green, and the bound is the thing that stops a 250 KB-per-node
    // buffer growing without limit.
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    for (let i = 0; i < 3000; i++) {
      handler!(null, { type: 'node_created', node: { id: `n${i}`, generation: 0, status: 'pending' } });
    }
    handler!(null, { type: 'status', status: 'finished' });
    handler!(null, { type: 'stop', reason: 'budget' });

    useEvaluationStore.getState().hydrate(RUN, snapshot());
    const after = useEvaluationStore.getState().evaluations.get(RUN)!;
    // The tail survives...
    expect(after.status).toBe('finished');
    expect(after.stopReason).toBe('budget');
    // ...and the buffer did NOT retain all 3002 events.
    expect(after.generations.flat().length).toBeLessThan(3000);
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
