import { describe, it, expect } from 'vitest';
import { withRetry, isRetryableError, RetryableError } from '../../src/providers/retry';

describe('RetryableError', () => {
  it('is an instance of Error', () => {
    const err = new RetryableError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the message', () => {
    const err = new RetryableError('my message');
    expect(err.message).toBe('my message');
  });

  it('stores statusCode', () => {
    const err = new RetryableError('test', 429);
    expect((err as any).statusCode).toBe(429);
  });
});

describe('isRetryableError', () => {
  it('returns true for RetryableError', () => {
    expect(isRetryableError(new RetryableError('test'))).toBe(true);
  });

  it('returns true for error.statusCode 429', () => {
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
  });

  it('returns true for error.status 429', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it('returns true for 500 statusCode', () => {
    expect(isRetryableError({ statusCode: 500 })).toBe(true);
  });

  it('returns true for 502 statusCode', () => {
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
  });

  it('returns true for 503 statusCode', () => {
    expect(isRetryableError({ statusCode: 503 })).toBe(true);
  });

  it('returns true for 408 statusCode', () => {
    expect(isRetryableError({ statusCode: 408 })).toBe(true);
  });

  it('returns true for ECONNRESET code', () => {
    const err = { code: 'ECONNRESET' };
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT code', () => {
    const err = { code: 'ETIMEDOUT' };
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for 400 statusCode', () => {
    expect(isRetryableError({ statusCode: 400 })).toBe(false);
  });

  it('returns false for 401 statusCode', () => {
    expect(isRetryableError({ statusCode: 401 })).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isRetryableError(new Error('test'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns value on first success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on retryable error and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new RetryableError('transient');
        return 'success';
      },
      { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 }
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws immediately on non-retryable error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('permanent');
        },
        { maxRetries: 3, initialDelayMs: 1 }
      )
    ).rejects.toThrow('permanent');
    expect(attempts).toBe(1);
  });

  it('throws after exhausting retries (1 initial + maxRetries retries)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new RetryableError('always fails');
        },
        { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 10 }
      )
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('respects maxRetries=0 (single attempt, no retries)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new RetryableError('fail');
        },
        { maxRetries: 0, initialDelayMs: 1 }
      )
    ).rejects.toThrow('fail');
    expect(attempts).toBe(1);
  });
});
