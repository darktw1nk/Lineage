/**
 * Partial-spend propagation for genetic operators.
 *
 * Operators (mutation, meta-prompting, crossover) make several LLM calls and
 * accumulate their cost internally. When a later step throws — the common
 * real-world case of a service model emitting prose instead of JSON — that
 * accumulated cost used to die with the exception: the money was spent at the
 * provider but never reached run totals, the cost breakdown, the report, or
 * the budget check. Attaching it to the error lets callers account for it.
 */

export interface OperatorCost {
  promptTokens: number;
  completionTokens: number;
  usd: number;
  calls: number;
}

export const ZERO_OPERATOR_COST: OperatorCost = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 };

const COST_KEY = '__partialCost';

/**
 * Attach already-incurred cost to an error before rethrowing it.
 *
 * Never let the bookkeeping destroy the error: a frozen or sealed error (ESM
 * strict mode makes the assignment throw, not fail silently) would otherwise
 * replace a useful provider message with "object is not extensible".
 */
export function withPartialCost(error: unknown, cost: OperatorCost): unknown {
  if (error && typeof error === 'object') {
    try {
      // Snapshot the NUMBERS, not the caller's object. A plugin that keeps
      // mutating the cost it passed here changed what the engine billed later.
      const snapshot = { ...cost };
      Object.defineProperty(error, COST_KEY, { value: snapshot, enumerable: false, configurable: true, writable: true });
    } catch {
      // Frozen/sealed error: the spend goes unreported, but the original error survives.
      console.warn('[Operators] Could not attach partial cost to a frozen error — that spend will not be accounted');
    }
  }
  return error;
}

/** Recover cost incurred before a failure; zero when the error carries none. */
export function partialCostOf(error: unknown): OperatorCost {
  if (error && typeof error === 'object') {
    const cost = (error as Record<string, unknown>)[COST_KEY];
    if (cost && typeof cost === 'object') {
      const c = cost as Partial<OperatorCost>;
      // Sanitise at the boundary, exactly as generation.ts's `finite()` does on
      // the SUCCESS path. This path did not, and accrueCost adds the value
      // straight into totals: one NaN made `totals.usd` NaN, and because
      // `NaN >= budget` is false, budgetUSD was disarmed for the rest of the
      // run — measured end to end as `Total cost: $NaN` with stopReason
      // "generations" and the cap never firing. A string produced a STRING
      // total (1.0 + "1.5" = "11.5"). Reachable from any plain-object plugin
      // adapter, which bypasses BaseProviderAdapter's clamp; the project's own
      // rule from the OpenRouter "-1" incident is that negative prices must be
      // rejected at EVERY entry point, and this was a missed one.
      const num = (v: unknown): number => {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      };
      return {
        promptTokens: num(c.promptTokens),
        completionTokens: num(c.completionTokens),
        usd: num(c.usd),
        calls: num(c.calls),
      };
    }
  }
  return { ...ZERO_OPERATOR_COST };
}
