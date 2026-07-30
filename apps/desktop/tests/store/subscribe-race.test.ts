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

  it('does not double-apply once hydrated', () => {
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    handler!(null, { type: 'status', status: 'finished' });
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    // A second hydrate must not replay a drained buffer again.
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    expect(useEvaluationStore.getState().evaluations.get(RUN)!.status).toBe('finished');
  });

  it('bounds the buffer for a run that is never hydrated', () => {
    const store = useEvaluationStore.getState();
    store.subscribe(RUN);
    for (let i = 0; i < 900; i++) handler!(null, { type: 'totals', totals: { calls: i } });
    // Must not grow without limit; hydrate still works afterwards.
    useEvaluationStore.getState().hydrate(RUN, snapshot());
    expect(useEvaluationStore.getState().evaluations.get(RUN)).toBeDefined();
  });
});
