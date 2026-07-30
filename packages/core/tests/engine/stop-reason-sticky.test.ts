import { describe, it, expect, vi } from 'vitest';
import { setStopReason as set } from '../../src/engine/evaluator_v2.js';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

/**
 * An unrecoverable error must not be relabelled as an ordinary stop.
 *
 * The grading circuit breaker sets `stopReason: 'error'`, but two unconditional
 * writers still run during finishEvaluation's `while (inProgress.size > 0)`
 * drain — shouldStop() and processNode's BudgetExhaustedError branch. Measured
 * with a budget tuned to land in that window: a run whose judge failed to parse
 * 20/20, with every score fabricated, reported `stopReason: "budget"` and
 * exited 0. docs/cli.md tells agents to branch on stopReason, and the CLI exits
 * 1 on `error` precisely so a breaker-aborted run is not read as a cheap stop.
 */
describe('stopReason downgrades are refused', () => {
  it.each(['budget', 'time', 'target', 'generations', 'exhausted'])(
    'error survives a later %s', (later) => {
      const state = { run: { stopReason: 'error' } };
      set(state, later);
      expect(state.run.stopReason).toBe('error');
    },
  );

  it('manual survives a later budget stop', () => {
    const state = { run: { stopReason: 'manual' } };
    set(state, 'budget');
    expect(state.run.stopReason).toBe('manual');
  });

  it('an error still overrides an ordinary reason already set', () => {
    const state = { run: { stopReason: 'generations' } };
    set(state, 'error');
    expect(state.run.stopReason).toBe('error');
  });

  it('ordinary reasons still overwrite each other', () => {
    const state = { run: { stopReason: 'generations' } };
    set(state, 'budget');
    expect(state.run.stopReason).toBe('budget');
  });
});
