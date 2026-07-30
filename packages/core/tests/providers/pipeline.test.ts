import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, RetryableError } from '../../src/providers/retry';
import { initGlobalSemaphore, withGlobalSemaphore } from '../../src/engine/semaphore';

describe('provider pipeline integration', () => {
  beforeEach(() => {
    initGlobalSemaphore(5);
  });

  it('semaphore + retry work together correctly', async () => {
    initGlobalSemaphore(2);
    let attempts = 0;

    const result = await withGlobalSemaphore(async () => {
      return await withRetry(
        async () => {
          attempts++;
          if (attempts < 2) throw new RetryableError('transient', 429);
          return 'success';
        },
        { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 }
      );
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('semaphore limits concurrent provider calls', async () => {
    initGlobalSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const simulateProviderCall = async (provider: string) => {
      return withGlobalSemaphore(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 30));
        concurrent--;
        return `${provider} done`;
      }, provider);
    };

    // Simulate 6 calls across multiple providers
    const results = await Promise.all([
      simulateProviderCall('openai'),
      simulateProviderCall('anthropic'),
      simulateProviderCall('gemini'),
      simulateProviderCall('openai'),
      simulateProviderCall('anthropic'),
      simulateProviderCall('gemini'),
    ]);

    expect(results).toHaveLength(6);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('retry releases semaphore permit on failure and re-acquires on retry', async () => {
    initGlobalSemaphore(1);
    let attempts = 0;
    let semaphoreAcquireCount = 0;

    const result = await withGlobalSemaphore(async () => {
      semaphoreAcquireCount++;
      return await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw new RetryableError('fail');
          return 'success';
        },
        { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 }
      );
    });

    expect(result).toBe('success');
    // Semaphore should have been acquired once (retry happens inside the semaphore)
    expect(semaphoreAcquireCount).toBe(1);
    expect(attempts).toBe(3);
  });

  // Renamed: this asserts its OWN local increments, so it never touched the
  // engine's accrueCost. What it does genuinely exercise is that concurrent
  // work under the semaphore all completes, so that is what it now claims.
  it('every concurrent call under the semaphore completes exactly once', async () => {
    const costs = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 };

    const simulateCall = async (tokens: number, cost: number) => {
      return withGlobalSemaphore(async () => {
        costs.promptTokens += tokens;
        costs.completionTokens += Math.floor(tokens * 0.5);
        costs.usd += cost;
        costs.calls++;
        return { tokens, cost };
      });
    };

    // Simulate 10 API calls with varying costs
    await Promise.all([
      simulateCall(100, 0.001),
      simulateCall(200, 0.002),
      simulateCall(150, 0.0015),
      simulateCall(300, 0.003),
      simulateCall(50, 0.0005),
      simulateCall(100, 0.001),
      simulateCall(200, 0.002),
      simulateCall(150, 0.0015),
      simulateCall(300, 0.003),
      simulateCall(50, 0.0005),
    ]);

    expect(costs.calls).toBe(10);
    expect(costs.promptTokens).toBe(1600); // 2 * (100+200+150+300+50)
    expect(costs.completionTokens).toBe(800);
    expect(costs.usd).toBeCloseTo(0.016);
  });

  it('non-retryable error propagates immediately through pipeline', async () => {
    initGlobalSemaphore(3);

    await expect(
      withGlobalSemaphore(async () => {
        return await withRetry(
          async () => {
            throw new Error('API key invalid'); // Non-retryable
          },
          { maxRetries: 3, initialDelayMs: 1 }
        );
      })
    ).rejects.toThrow('API key invalid');

    // Semaphore should be released — verify by acquiring again
    const result = await withGlobalSemaphore(async () => 'recovered');
    expect(result).toBe('recovered');
  });
});
// REMOVED: describe('stop conditions')
//
// Five tests named for budget, time limit, target fitness, generation limit
// and "none met" that imported nothing from the engine. Each declared local
// numbers and asserted that JavaScript's `>` operator works, so all five
// passed with shouldStop() deleted from the codebase — and a coverage report
// that claims the stop conditions are tested is worse than one that admits
// they are not. Mutation testing confirmed all four shouldStop branches are
// unprotected (budgetUSD !== undefined -> truthiness, >= -> >, and the
// generations/target label swap all survive).
//
// Real coverage belongs in an end-to-end harness like
// tests/engine/budget-enforcement.test.ts, which drives a whole run and
// asserts stopReason. targetFitness and timeLimitMs still have none.
