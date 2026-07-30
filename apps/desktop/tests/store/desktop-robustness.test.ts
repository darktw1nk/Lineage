import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {}, ipcMain: {},
  app: { isPackaged: true, getPath: () => '/tmp' },
}));

import { useEvaluationStore } from '../../src/store/evaluationStore';

const store = () => useEvaluationStore.getState();

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, configId: 'c', startedAt: Date.now(),
  totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
  generations: [[]], cacheHits: 0, version: '1.0', ...over,
} as any);

beforeEach(() => store().cleanup());

/**
 * eval:import checks that `generations` is an array of arrays but never looks
 * INSIDE them. A file with null/number entries imports cleanly and then throws
 * on first render — and LeftSidebar is the one panel App.tsx does not wrap in
 * an ErrorBoundary, so the whole window blanks with no way to select or delete
 * anything. The reason reaches only the closed-by-default Logs panel.
 */
describe('a malformed node cannot blank the window', () => {
  it('hydrate survives null and non-object nodes', () => {
    store().setEvaluation('r', run('r'));
    expect(() =>
      store().hydrate('r', run('r', { generations: [[null, 5, { id: 'ok' }]] })),
    ).not.toThrow();
  });

  it('addGenerationToEvaluation drops junk instead of storing it', () => {
    store().setEvaluation('r', run('r'));
    store().addGenerationToEvaluation('r', 0, [null, 5, { id: 'ok', generation: 0 }] as any);
    const gen = store().evaluations.get('r')!.generations[0];
    expect(gen.every(n => n && typeof n === 'object' && typeof n.id === 'string')).toBe(true);
  });

  it('a node_updated with no id does not throw', () => {
    store().setEvaluation('r', run('r'));
    expect(() => store().updateNodeInEvaluation('r', { generation: 0 } as any)).not.toThrow();
    expect(() => store().addNodeToEvaluation('r', null as any)).not.toThrow();
  });
});

/**
 * `run.status` is only written at specific lifecycle points, so a run started
 * earlier and opened mid-flight carries status undefined. LIVE matched only
 * ['running','pausing','paused'], so releaseInactive unsubscribed and evicted a
 * genuinely running run the moment another was opened.
 */
describe('releaseInactive does not evict a run that may be live', () => {
  it('keeps a run whose status is unknown', () => {
    store().setEvaluation('unknown', run('unknown'));           // no status field
    store().setEvaluation('done', run('done', { status: 'finished' }));
    store().releaseInactive('done');
    expect([...store().evaluations.keys()].sort()).toEqual(['done', 'unknown']);
  });

  it('still releases a genuinely finished run', () => {
    store().setEvaluation('a', run('a', { status: 'finished' }));
    store().setEvaluation('b', run('b', { status: 'finished' }));
    store().releaseInactive('b');
    expect([...store().evaluations.keys()]).toEqual(['b']);
  });
});

/** The engine sends `decisive`; dropping it makes the store disagree with the DB. */
describe('the store keeps playoff decisiveness', () => {
  it('records decisive alongside the ranking', () => {
    store().setEvaluation('r', run('r'));
    store().addPlayoff('r', { generation: 0, ranking: ['x', 'y'], decisive: false } as any);
    expect((store().evaluations.get('r')!.playoffs![0] as any).decisive).toBe(false);
  });
});
