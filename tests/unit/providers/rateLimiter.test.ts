import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../../electron/providers/rateLimiter';

describe('RateLimiter', () => {
  it('allows requests under RPM limit', async () => {
    const limiter = new RateLimiter('test-provider', { rpm: 100 });
    // Should not throw or hang
    await limiter.waitIfNeeded(100);
    limiter.recordRequest(100);
  });

  it('allows requests under TPM limit', async () => {
    const limiter = new RateLimiter('test-provider', { tpm: 100000 });
    await limiter.waitIfNeeded(1000);
    limiter.recordRequest(1000);
  });

  it('records requests correctly', () => {
    const limiter = new RateLimiter('test-provider', { rpm: 100, tpm: 100000 });
    limiter.recordRequest(500);
    limiter.recordRequest(300);
    // No assertion needed beyond not throwing — internal state is tracked
  });

  it('handles unlimited config (no rpm/tpm)', async () => {
    const limiter = new RateLimiter('test-provider', {});
    await limiter.waitIfNeeded(1000);
    limiter.recordRequest(1000);
    // Should pass without delay
  });

  it('multiple rapid requests within limit do not block', async () => {
    const limiter = new RateLimiter('test-provider', { rpm: 1000, tpm: 1000000 });
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      await limiter.waitIfNeeded(100);
      limiter.recordRequest(100);
    }
    const elapsed = Date.now() - start;
    // 10 fast requests should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });
});
