import { describe, it, expect } from 'vitest';
import { withRetry, isRetryableError, RetryableError } from '../../src/providers/retry.js';

/**
 * Two holes the hunter measured:
 *  - `Retry-After` is never read, so all four attempts land inside the window
 *    the provider explicitly asked us to wait out — guaranteed 429s, and on
 *    providers that extend the window on continued hammering it makes the rate
 *    limit worse.
 *  - A 200 carrying a non-JSON body (a Cloudflare HTML error page, an SSE
 *    stream) throws SyntaxError, which has no status and no cause.code, so it
 *    is NON-retryable — while a merely empty JSON body gets four attempts. The
 *    worse failure fails permanently.
 */
describe('Retry-After is honoured', () => {
  it('waits at least as long as the provider asked', async () => {
    let attempts = 0;
    const started = Date.now();
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        const e: any = new RetryableError('rate limited', 429);
        e.retryAfterMs = 400; // what a `Retry-After: 0.4` would carry
        throw e;
      }
      return 'ok';
    }, { maxRetries: 3, initialDelayMs: 10 });

    expect(result).toBe('ok');
    // Without honouring it the backoff would be ~10ms, far inside the window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  }, 20000);
});

describe('a non-JSON body from a 200 is retryable', () => {
  it('classifies a SyntaxError from response parsing as retryable', () => {
    // A transient gateway HTML page killed the node on the first try with
    // "Provider openai call failed: Unexpected token '<'".
    const e = new SyntaxError(`Unexpected token '<', "<html>" is not valid JSON`);
    expect(isRetryableError(e)).toBe(true);
  });

  it('does not make every SyntaxError retryable', () => {
    // A genuine programming error must still fail fast.
    expect(isRetryableError(new SyntaxError('Invalid regular expression'))).toBe(false);
  });

  it('still refuses to retry a plain 400', () => {
    // RetryableError is an explicit "retry me" marker, so a 400 has to arrive
    // as an ordinary error carrying a status for this assertion to mean
    // anything — my first version tested the marker and failed for that reason.
    const e: any = new Error('bad request');
    e.status = 400;
    expect(isRetryableError(e)).toBe(false);
  });
});

describe('adapters read the Retry-After header off the response', () => {
  it('openai attaches retryAfterMs from a 429', async () => {
    // The plumbing in withRetry is dead unless the adapter puts the header on
    // the error. The header IS reachable — fetchWithTimeout reconstructs a
    // real Response — so this was a pure omission.
    const { OpenAIAdapter } = await import('../../src/providers/openai.js');
    const original = globalThis.fetch;
    let seen: any;
    globalThis.fetch = (async () => ({
      ok: false, status: 429, statusText: 'Too Many Requests',
      headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) },
      text: async () => 'slow down',
    })) as any;
    try {
      await new OpenAIAdapter().callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 8 })
        .catch((e: any) => { seen = e; });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen?.retryAfterMs).toBe(2000);
  }, 60000);
});
