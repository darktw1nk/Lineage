import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { evaluateSafetyGuardrails } from '../../src/engine/fitness.js';

const judge = (reply: string | (() => never)) => ({
  name: 'j',
  estimateTokens: () => ({ prompt: 1 }),
  call: async () => {
    if (typeof reply === 'function') reply();
    return { output: reply as string, promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.001 };
  },
} as any);

const run = (reply: string | (() => never), guardrails = ['no violence']) =>
  evaluateSafetyGuardrails('some output', guardrails, { provider: 'j', model: 'm' }, judge(reply), 100);

/**
 * The whole safety dimension had no test. Every failure — network outage, 401,
 * unparseable reply, prose — was caught and pushed 5, which lands in
 * node.metrics.safety and is treated as MEASURED, keeping the weight in the
 * denominator. A run with a dead service key completed reporting fitness 7.5
 * with zero safety evidence: calls=0, usd=0, nothing in the cost breakdown.
 * The file enforces the opposite rule two functions away: a dimension that
 * cannot be measured must be DISABLED, never defaulted.
 */
describe('an unmeasurable safety dimension is disabled, not defaulted', () => {
  it('a judge outage yields no score at all', async () => {
    const r = await run(() => { throw new Error('ECONNRESET'); });
    expect(r.score).toBeUndefined();
    // A dispatched call that threw is still a call the provider served and may
    // bill: `calls++` sat AFTER the await, so an outage was invisible to totals
    // and to budgetUSD. Only throws from BEFORE the request stay uncounted.
    expect(r.calls).toBe(1);
  });

  it('an unparseable reply yields no score', async () => {
    const r = await run('I think this is probably fine, honestly.');
    expect(r.score).toBeUndefined();
  });

  it('a mis-scaled score is rejected, not clamped to a perfect 10', async () => {
    // A judge answering on 0-100 is common drift. Clamping 99 -> 10 makes the
    // dimension fail OPEN, which is the opposite of what a safety check is for.
    expect((await run('{"score": 99}')).score).toBeUndefined();
    expect((await run('{"score": -40}')).score).toBeUndefined();
  });

  it('still reports a genuine score, including 0', async () => {
    expect((await run('{"score": 8}')).score).toBe(8);
    expect((await run('{"score": 0}')).score).toBe(0);
    expect((await run('{"score": 8.7}')).score).toBeCloseTo(8.7, 5);
  });

  it('averages only the guardrails that were actually measured', async () => {
    let n = 0;
    const flaky = {
      name: 'j', estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        if (++n === 2) throw new Error('outage');
        return { output: '{"score": 6}', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.001 };
      },
    } as any;
    const r = await evaluateSafetyGuardrails('o', ['a', 'b', 'c'], { provider: 'j', model: 'm' }, flaky, 100);
    expect(r.score).toBe(6);   // mean of the two that answered, not dragged by a 5
    expect(r.calls).toBe(3); // 2 answered + 1 dispatched-and-threw
  });

  it('a guardrail list with no usable rules makes no paid calls', async () => {
    const r = await run('{"score": 8}', [null as any, 5 as any, {} as any]);
    expect(r.calls).toBe(0);
    expect(r.score).toBeUndefined();
  });
});
