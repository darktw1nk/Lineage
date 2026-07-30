import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';

/**
 * A content-policy refusal is DETERMINISTIC: the same prompt is refused every
 * time. Throwing RetryableError made each one cost four billed HTTP requests
 * that could not possibly differ, and the engine then accrued the throw as
 * `{usd: 0, calls: 1}` — so one logical call made four paid requests, was
 * reported as one call at $0, and `budgetUSD` never saw the spend.
 *
 * Evolution explores prompts, so some WILL trip content filters; this is a
 * routine path, not an edge case.
 *
 * Genuinely transient blocks stay retryable. MALFORMED_FUNCTION_CALL is a
 * sampling artefact — a re-roll at nonzero temperature really can succeed —
 * and an empty `candidates` array carries no verdict at all.
 */
let calls = 0;
const respondWith = (payload: unknown) => {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload, text: async () => '' } as any;
  }) as any;
};
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

const openai = (finish: string) => ({
  choices: [{ message: { content: '' }, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const gemini = (finishReason: string) => ({
  candidates: [{ content: { parts: [{ text: '' }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
});

const run = (adapter: any) =>
  adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 8, maxRetries: 4 });

describe('a deterministic refusal is not paid for four times', () => {
  it('openai content_filter is attempted once', async () => {
    respondWith(openai('content_filter'));
    await expect(run(new OpenAIAdapter())).rejects.toThrow(/content_filter/);
    expect(calls).toBe(1);
  });

  it.each(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])(
    'gemini %s is attempted once', async (reason) => {
      respondWith(gemini(reason));
      await expect(run(new GeminiAdapter())).rejects.toThrow(new RegExp(reason));
      expect(calls).toBe(1);
    },
  );
});

describe('genuinely transient blocks are still retried', () => {
  it('gemini MALFORMED_FUNCTION_CALL is re-rolled', async () => {
    respondWith(gemini('MALFORMED_FUNCTION_CALL'));
    await expect(run(new GeminiAdapter())).rejects.toThrow();
    expect(calls).toBe(4);
  });

  it('gemini with no candidates at all is retried', async () => {
    respondWith({ candidates: [], usageMetadata: {} });
    await expect(run(new GeminiAdapter())).rejects.toThrow();
    expect(calls).toBe(4);
  });
});

/**
 * MAX_RETRY_AFTER_MS caps each SLEEP, not the call. Three retries at the cap is
 * three minutes, and base.ts wraps withRetry INSIDE withGlobalSemaphore, so all
 * of it is a parallel slot held. `callTimeoutMs` bounds only the HTTP attempt
 * and `timeLimitMs` is only checked at node boundaries, so nothing aborts it.
 * `Retry-After: 3600` on a 503 is routine edge-network behaviour, and all five
 * adapters now attach the header.
 *
 * Measured: no header 7.4s, `Retry-After: 2` 6.0s, `Retry-After: 3600` 180.0s.
 */
describe('Retry-After cannot stall a slot for minutes', () => {
  it('bounds the TOTAL time spent waiting, not just each sleep', async () => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: false, status: 503, statusText: 'Service Unavailable',
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '3600' : null) },
        json: async () => ({}), text: async () => 'unavailable',
      } as any;
    }) as any;

    const started = Date.now();
    await expect(run(new OpenAIAdapter())).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(70_000); // was 180_015ms
    // And it stops rather than retrying EARLIER than the provider asked, which
    // is a guaranteed repeat failure and extends the window on providers that
    // penalise continued hammering.
    expect(calls).toBeLessThan(4);
  }, 200_000);
});
