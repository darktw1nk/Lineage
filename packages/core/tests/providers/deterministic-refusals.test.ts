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
