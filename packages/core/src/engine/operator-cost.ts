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
      Object.defineProperty(error, COST_KEY, { value: cost, enumerable: false, configurable: true, writable: true });
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
      return {
        promptTokens: c.promptTokens ?? 0,
        completionTokens: c.completionTokens ?? 0,
        usd: c.usd ?? 0,
        calls: c.calls ?? 0,
      };
    }
  }
  return { ...ZERO_OPERATOR_COST };
}
