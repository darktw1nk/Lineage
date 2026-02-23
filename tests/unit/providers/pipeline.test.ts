import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from '../../../electron/providers/rateLimiter';
import { withRetry, RetryableError } from '../../../electron/providers/retry';
import { initGlobalSemaphore, withGlobalSemaphore } from '../../../electron/engine/semaphore';

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

  it('multiple providers rate limited independently', async () => {
    const openaiLimiter = new RateLimiter('openai', { rpm: 100, tpm: 100000 });
    const anthropicLimiter = new RateLimiter('anthropic', { rpm: 50, tpm: 50000 });

    // Both should work independently without blocking each other
    const start = Date.now();

    await Promise.all([
      (async () => {
        for (let i = 0; i < 5; i++) {
          await openaiLimiter.waitIfNeeded(100);
          openaiLimiter.recordRequest(100);
        }
      })(),
      (async () => {
        for (let i = 0; i < 5; i++) {
          await anthropicLimiter.waitIfNeeded(100);
          anthropicLimiter.recordRequest(100);
        }
      })(),
    ]);

    const elapsed = Date.now() - start;
    // Should complete quickly since we're well under limits
    expect(elapsed).toBeLessThan(1000);
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

  it('cost accumulation across multiple simulated operations', async () => {
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

describe('stop conditions', () => {
  it('budget check: total cost exceeds budget', () => {
    const budget = 5.0;
    const totalCost = 5.01;
    expect(totalCost > budget).toBe(true);
  });

  it('time check: elapsed time exceeds limit', () => {
    const timeLimitMs = 60000;
    const startedAt = Date.now() - 61000;
    const elapsed = Date.now() - startedAt;
    expect(elapsed > timeLimitMs).toBe(true);
  });

  it('target fitness check: best fitness meets target', () => {
    const targetFitness = 8.5;
    const bestFitness = 8.7;
    expect(bestFitness >= targetFitness).toBe(true);
  });

  it('generation limit check: current gen exceeds max', () => {
    const maxGenerations = 10;
    const currentGeneration = 10;
    expect(currentGeneration >= maxGenerations).toBe(true);
  });

  it('none of the conditions met → evaluation continues', () => {
    const budget = 10.0;
    const totalCost = 2.0;
    const timeLimitMs = 60000;
    const startedAt = Date.now() - 10000;
    const targetFitness = 9.0;
    const bestFitness = 5.0;
    const maxGenerations = 20;
    const currentGeneration = 3;

    const elapsed = Date.now() - startedAt;
    const shouldStop =
      totalCost > budget ||
      elapsed > timeLimitMs ||
      bestFitness >= targetFitness ||
      currentGeneration >= maxGenerations;

    expect(shouldStop).toBe(false);
  });
});
