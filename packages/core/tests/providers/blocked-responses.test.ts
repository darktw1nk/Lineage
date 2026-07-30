import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';

function respond(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as any;
}

async function call(adapter: any, body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => respond(body)) as any;
  try {
    return { ok: true as const, result: await adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 32 }) };
  } catch (error: any) {
    return { ok: false as const, error };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A blocked or filtered response is a FAILURE, not an empty completion. Treated
 * as success it bills $0, grades the candidate on "", and kills the lineage —
 * instead of being retried like every other provider-side failure.
 */
describe('a blocked candidate is not a successful empty answer', () => {
  for (const finishReason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'MALFORMED_FUNCTION_CALL']) {
    it(`gemini rejects finishReason ${finishReason}`, async () => {
      // Only `candidates.length === 0` was checked. A candidate PRESENT with no
      // content — the commonest Gemini failure — slid straight through.
      const r = await call(new GeminiAdapter(), {
        candidates: [{ finishReason, content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
      });
      expect(r.ok).toBe(false);
      expect(String(r.ok === false && r.error?.message)).toContain(finishReason);
    });
  }

  it('gemini still accepts a normal STOP with content', async () => {
    const r = await call(new GeminiAdapter(), {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.result.output).toBe('hello');
  });

  it('gemini accepts a MAX_TOKENS reply — truncated, but real content', async () => {
    const r = await call(new GeminiAdapter(), {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'cut' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.result.truncated).toBe(true);
  });

  it('openai surfaces a refusal instead of grading an empty string', async () => {
    // `message.refusal` was dropped entirely: output "", billed tokens, and the
    // judge graded nothing. The user cannot tell a refusal from a broken call.
    const r = await call(new OpenAIAdapter(), {
      choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 14 },
    });
    expect(r.ok && r.result.output).toContain('cannot help');
  });

  it('openai flags a content_filter stop', async () => {
    const r = await call(new OpenAIAdapter(), {
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });
    expect(r.ok).toBe(false);
  });
});
