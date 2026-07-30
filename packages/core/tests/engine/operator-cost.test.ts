import { describe, it, expect } from 'vitest';
import { withPartialCost, partialCostOf } from '../../src/engine/operator-cost.js';

/**
 * This recovers already-billed spend from a FAILED operator into run totals and
 * the budget check, and it validated nothing. `accrueCost` does
 * `totals.usd += c.usd` unguarded, and both `budgetExhausted` and `reserveCall`
 * test `totals.usd >= budget` — and `NaN >= x` is always false. So one NaN
 * disarms budgetUSD for the rest of the run.
 *
 * Reachable via a plain-object plugin adapter, which docs/plugins.md documents
 * as supported and which bypasses BaseProviderAdapter's clamp. The same doc
 * tells plugin authors to call withPartialCost.
 */
const attach = (cost: unknown) => partialCostOf(withPartialCost(new Error('boom'), cost as any));

describe('a plugin cannot poison run totals through a failed operator', () => {
  it('NaN becomes 0 rather than making totals NaN', () => {
    expect(attach({ promptTokens: 1, completionTokens: 1, usd: NaN, calls: 1 }).usd).toBe(0);
  });

  it('Infinity and negatives are rejected', () => {
    expect(attach({ promptTokens: 1, completionTokens: 1, usd: Infinity, calls: 1 }).usd).toBe(0);
    expect(attach({ promptTokens: 1, completionTokens: 1, usd: -5, calls: 1 }).usd).toBe(0);
  });

  it('a string cost does not turn totals into a string', () => {
    // Measured: totals.usd 1.0 += "1.5" produced the STRING "11.5".
    const c = attach({ promptTokens: 1, completionTokens: 1, usd: '1.5', calls: 1 });
    expect(typeof c.usd).toBe('number');
  });

  it('token counts and call counts are sanitised too', () => {
    const c = attach({ promptTokens: NaN, completionTokens: '4', usd: 0.5, calls: -2 });
    expect(Number.isFinite(c.promptTokens)).toBe(true);
    expect(Number.isFinite(c.completionTokens)).toBe(true);
    expect(c.calls).toBeGreaterThanOrEqual(0);
  });

  it('a legitimate cost still round-trips exactly', () => {
    const c = attach({ promptTokens: 10, completionTokens: 4, usd: 0.002, calls: 2 });
    expect(c).toMatchObject({ promptTokens: 10, completionTokens: 4, usd: 0.002, calls: 2 });
  });

  it('a zero cost stays zero rather than being coerced away', () => {
    expect(attach({ promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 }).usd).toBe(0);
  });

  it('a non-object throw yields clean zeros', () => {
    for (const thrown of ['boom', 42, null, undefined, true]) {
      expect(partialCostOf(thrown as any)).toMatchObject({ usd: 0, calls: 0 });
    }
  });

  it('mutating the source cost afterwards does not change what is billed', () => {
    const live: any = { promptTokens: 1, completionTokens: 1, usd: 0.01, calls: 1 };
    const err = withPartialCost(new Error('x'), live);
    live.usd = 999;
    expect(partialCostOf(err).usd).toBe(0.01);
  });
});
