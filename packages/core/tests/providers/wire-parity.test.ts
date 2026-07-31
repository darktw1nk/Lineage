import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

/**
 * Every audit of this project has faked only the OPENAI wire shape, so four of
 * five adapters have never had their response parsing exercised at all — while
 * the engine treats all five interchangeably and bills, grades and budgets off
 * whatever they return. A provider that reports the wrong token counts corrupts
 * cost accounting silently; one that drops `truncated` grades a reply cut off by
 * the token cap as a bad answer.
 *
 * Each adapter gets a realistic success body, a truncation signal, and a usage
 * block, in that provider's own shape.
 */
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

const respond = (payload: unknown) => {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => payload, text: async () => '',
  })) as any;
};

const call = (adapter: any) =>
  adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 64 });

/** [name, adapter, ok body, truncated body] in each provider's native shape. */
const WIRE: Array<[string, any, unknown, unknown]> = [
  ['openai', new OpenAIAdapter(),
    { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    { choices: [{ message: { content: 'HELL' }, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }],
  ['anthropic', new AnthropicAdapter(),
    { content: [{ type: 'text', text: 'HELLO' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } },
    { content: [{ type: 'text', text: 'HELL' }], stop_reason: 'max_tokens', usage: { input_tokens: 11, output_tokens: 7 } }],
  ['gemini', new GeminiAdapter(),
    { candidates: [{ content: { parts: [{ text: 'HELLO' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } },
    { candidates: [{ content: { parts: [{ text: 'HELL' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } }],
  ['groq', new GroqAdapter(),
    { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    { choices: [{ message: { content: 'HELL' }, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }],
  ['openrouter', new OpenRouterAdapter(),
    { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    { choices: [{ message: { content: 'HELL' }, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }],
];

describe('every adapter reads its own wire the same way', () => {
  it.each(WIRE)('%s returns the text and the real token counts', async (_n, adapter, ok) => {
    respond(ok);
    const r = await call(adapter);
    expect(r.output).toBe('HELLO');
    // Token counts feed cost accounting and budgetUSD. A provider reporting
    // zeros bills every call at $0 and the cap can never trip.
    expect(r.promptTokens).toBe(11);
    expect(r.completionTokens).toBe(7);
    expect(r.truncated).toBeFalsy();
  });

  it.each(WIRE)('%s surfaces truncation instead of grading a cut-off reply', async (_n, adapter, _ok, cut) => {
    respond(cut);
    const r = await call(adapter);
    // Without this the judge scores a reply the TOKEN CAP ended as a bad answer,
    // and evolution learns to avoid whatever the candidate was doing.
    expect(r.truncated).toBe(true);
  });

  it.each(WIRE)('%s reports latency it actually measured', async (_n, adapter, ok) => {
    respond(ok);
    const r = await call(adapter);
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.latencyMs)).toBe(true);
  });
});
