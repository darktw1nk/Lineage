import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEvaluationStore } from '../../src/store/evaluationStore';
import type { EvaluationRun, CandidateNode } from '../../src/types';

// ---------------------------------------------------------------------------
// window.electronAPI stub (only eval.subscribe is used by the store)
// ---------------------------------------------------------------------------

let capturedCallbacks: Map<string, (event: any, data: any) => void>;
let unsubscribeSpies: Map<string, ReturnType<typeof vi.fn>>;
const subscribeSpy = vi.fn((runId: string, cb: (event: any, data: any) => void) => {
  capturedCallbacks.set(runId, cb);
  const unsub = vi.fn();
  unsubscribeSpies.set(runId, unsub);
  return unsub;
});

vi.stubGlobal('window', { electronAPI: { eval: { subscribe: subscribeSpy } } });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(id: string): EvaluationRun {
  return {
    id,
    configId: 'cfg-1',
    startedAt: 1000,
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [[]],
    cacheHits: 0,
    version: '1.0',
  } as EvaluationRun;
}

function makeNode(id: string, generation = 0, overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    id,
    generation,
    lineageParents: [],
    status: 'pending',
    prompt: 'p',
    params: { model: { provider: 'gemini', model: 'gemini-2.5-flash-lite' }, temperature: 0.7 },
    changeLog: [],
    ...overrides,
  } as CandidateNode;
}

function reset(): void {
  useEvaluationStore.setState({
    evaluations: new Map(),
    subscriptions: new Map(),
    loading: new Set(),
  });
  capturedCallbacks = new Map();
  unsubscribeSpies = new Map();
  subscribeSpy.mockClear();
}

const store = () => useEvaluationStore.getState();

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe('evaluationStore mutations', () => {
  beforeEach(reset);

  it('setEvaluation stores a run retrievable by id', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    expect(store().evaluations.get('run-1')?.id).toBe('run-1');
  });

  it('updateNodeInEvaluation replaces an existing node immutably', () => {
    store().setEvaluation('run-1', { ...makeRun('run-1'), generations: [[makeNode('n1')]] });
    const before = store().evaluations.get('run-1')!;

    store().updateNodeInEvaluation('run-1', makeNode('n1', 0, { status: 'finished' }));

    const after = store().evaluations.get('run-1')!;
    expect(after.generations[0][0].status).toBe('finished');
    expect(after).not.toBe(before); // new object identity for React
    expect(before.generations[0][0].status).toBe('pending'); // old state untouched
  });

  it('updateNodeInEvaluation adds unknown nodes, padding missing generations', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().updateNodeInEvaluation('run-1', makeNode('n9', 2));

    const gens = store().evaluations.get('run-1')!.generations;
    expect(gens).toHaveLength(3);
    expect(gens[1]).toEqual([]);
    expect(gens[2][0].id).toBe('n9');
  });

  it('ignores a node claiming an implausible generation index', () => {
    // node.generation arrives over IPC and was used as an array index, so a
    // node claiming generation 200000 allocated 200001 arrays in the padding
    // loop. Padding itself is legitimate (a late-subscribing renderer catches
    // up that way), so this is a sanity ceiling, not a tight bound.
    store().setEvaluation('run-1', makeRun('run-1'));
    store().updateNodeInEvaluation('run-1', makeNode('huge', 200_000));
    expect(store().evaluations.get('run-1')!.generations.length).toBeLessThan(10);

    store().updateNodeInEvaluation('run-1', makeNode('neg', -1));
    expect(store().evaluations.get('run-1')!.generations.length).toBeLessThan(10);
  });

  it('updateNodeInEvaluation is a no-op for unknown evaluations', () => {
    store().updateNodeInEvaluation('missing', makeNode('n1'));
    expect(store().evaluations.size).toBe(0);
  });

  it('addGenerationToEvaluation sets the generation nodes wholesale', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().addGenerationToEvaluation('run-1', 1, [makeNode('a', 1), makeNode('b', 1)]);

    const gens = store().evaluations.get('run-1')!.generations;
    expect(gens[1].map(n => n.id)).toEqual(['a', 'b']);
  });

  it('updateTotals sets totals and cacheHits', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().updateTotals('run-1', { tokensPrompt: 5, tokensCompletion: 6, usd: 0.01, calls: 2 }, 3);

    const run = store().evaluations.get('run-1')!;
    expect(run.totals.usd).toBe(0.01);
    expect(run.cacheHits).toBe(3);
  });

  it('updateStatus sets status and optional pause bookkeeping', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().updateStatus('run-1', 'paused', 1234, 999);

    const run = store().evaluations.get('run-1')! as any;
    expect(run.status).toBe('paused');
    expect(run.totalPausedMs).toBe(1234);
    expect(run.pausedAt).toBe(999);
  });

  it('setLoading tracks and clears loading state', () => {
    store().setLoading('run-1', true);
    expect(store().loading.has('run-1')).toBe(true);
    store().setLoading('run-1', false);
    expect(store().loading.has('run-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe('evaluationStore subscriptions', () => {
  beforeEach(reset);

  it('subscribe registers exactly one IPC subscription per evaluation', () => {
    store().subscribe('run-1');
    store().subscribe('run-1'); // duplicate — must be deduplicated

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(store().subscriptions.size).toBe(1);
  });

  it('IPC updates flow through the captured callback into state', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');

    const cb = capturedCallbacks.get('run-1')!;
    cb({}, { type: 'generation_created', generation: 1, nodes: [makeNode('g1n1', 1)] });
    cb({}, { type: 'totals', totals: { tokensPrompt: 1, tokensCompletion: 2, usd: 0.5, calls: 9 }, cacheHits: 4 });

    const run = store().evaluations.get('run-1')!;
    expect(run.generations[1][0].id).toBe('g1n1');
    expect(run.totals.calls).toBe(9);
    expect(run.cacheHits).toBe(4);
  });

  it('malformed updates without a type are ignored', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');

    expect(() => capturedCallbacks.get('run-1')!({}, null)).not.toThrow();
    expect(() => capturedCallbacks.get('run-1')!({}, {})).not.toThrow();
  });

  it('unsubscribe calls the cleanup function and forgets the subscription', () => {
    store().subscribe('run-1');
    store().unsubscribe('run-1');

    expect(unsubscribeSpies.get('run-1')).toHaveBeenCalledTimes(1);
    expect(store().subscriptions.size).toBe(0);

    // Re-subscribing after unsubscribe works (not stuck deduplicated)
    store().subscribe('run-1');
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
  });

  it('holdout_result updates the run', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');
    capturedCallbacks.get('run-1')!({}, {
      type: 'holdout_result',
      holdout: { testIds: ['t9'], samplesPerTest: 1, seed: { score: 5, perTest: [] }, champion: { score: 9, perTest: [] } },
    });
    expect((store().evaluations.get('run-1') as any).holdout.champion.score).toBe(9);
  });

  it('node_created is idempotent by node id (resume replay must not duplicate)', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');
    const cb = capturedCallbacks.get('run-1')!;
    const node = (v: string) => ({ id: 'n1', generation: 0, status: 'finished', prompt: v, params: {}, changeLog: [] });
    cb({}, { type: 'node_created', node: node('first') });
    cb({}, { type: 'node_created', node: node('replayed') }); // resume replay of same node
    const gen0 = (store().evaluations.get('run-1') as any).generations[0];
    expect(gen0.filter((n: any) => n.id === 'n1')).toHaveLength(1);
    expect(gen0.find((n: any) => n.id === 'n1').prompt).toBe('replayed'); // replaced, not ignored
  });

  it('playoff_result appends to run.playoffs', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');
    capturedCallbacks.get('run-1')!({}, { type: 'playoff_result', generation: 0, ranking: ['n2', 'n1'], matches: 6 });
    capturedCallbacks.get('run-1')!({}, { type: 'playoff_result', generation: 1, ranking: ['n1', 'n2'], matches: 4 });
    expect((store().evaluations.get('run-1') as any).playoffs).toEqual([
      { generation: 0, ranking: ['n2', 'n1'] },
      { generation: 1, ranking: ['n1', 'n2'] },
    ]);
    // Idempotent per generation: a re-run playoff replaces, never duplicates
    capturedCallbacks.get('run-1')!({}, { type: 'playoff_result', generation: 1, ranking: ['n2', 'n1'], matches: 4 });
    expect((store().evaluations.get('run-1') as any).playoffs).toEqual([
      { generation: 0, ranking: ['n2', 'n1'] },
      { generation: 1, ranking: ['n2', 'n1'] },
    ]);
  });

  it('cleanup unsubscribes everything', () => {
    store().subscribe('run-1');
    store().subscribe('run-2');
    store().cleanup();

    expect(unsubscribeSpies.get('run-1')).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpies.get('run-2')).toHaveBeenCalledTimes(1);
    expect(store().subscriptions.size).toBe(0);
  });

  it('records WHY a run stopped, not just that it finished', () => {
    // The switch had no 'stop' case, so the reason was logged as an unknown
    // event and dropped: a run cut short by the budget cap showed a plain
    // "Finished" until the app was restarted and re-read run_json.
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');

    const cb = capturedCallbacks.get('run-1')!;
    cb({}, { type: 'stop', reason: 'budget' });
    cb({}, { type: 'status', status: 'finished' });

    const run = store().evaluations.get('run-1')!;
    expect(run.stopReason).toBe('budget');
    expect(run.status).toBe('finished');
    expect(run.finishedAt).toBeTypeOf('number');
  });

  it('clears pausedAt on resume even though the engine sends it as undefined', () => {
    // `pausedAt !== undefined` ignored the engine's explicit "clear it" signal,
    // leaving a stale timestamp that kept inflating the paused-time display.
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');

    const cb = capturedCallbacks.get('run-1')!;
    cb({}, { type: 'status', status: 'paused', totalPausedMs: 0, pausedAt: 1000 });
    expect(store().evaluations.get('run-1')!.pausedAt).toBe(1000);

    cb({}, { type: 'status', status: 'running', totalPausedMs: 500, pausedAt: undefined });
    expect(store().evaluations.get('run-1')!.pausedAt).toBeUndefined();
    expect(store().evaluations.get('run-1')!.totalPausedMs).toBe(500);
  });
});
