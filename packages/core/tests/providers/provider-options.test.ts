import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const OK: Record<string, unknown> = {
  openai: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  groq: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  openrouter: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  anthropic: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
};

const ADAPTERS: Array<[string, any]> = [
  ['openai', new OpenAIAdapter()],
  ['anthropic', new AnthropicAdapter()],
  ['gemini', new GeminiAdapter()],
  ['groq', new GroqAdapter()],
  ['openrouter', new OpenRouterAdapter()],
];

async function requestBody(name: string, adapter: any, providerOptions: Record<string, unknown>): Promise<any> {
  const original = globalThis.fetch;
  let sent = '';
  globalThis.fetch = (async (_u: any, init: any) => {
    sent = String(init?.body ?? '');
    return { ok: true, status: 200, statusText: 'OK', json: async () => OK[name], text: async () => '' } as any;
  }) as any;
  try {
    await adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 8, providerOptions });
  } finally {
    globalThis.fetch = original;
  }
  return JSON.parse(sent);
}

/**
 * README documents providerOptions as "Passed through to candidate calls (e.g.
 * reasoning_effort)" with no provider caveat. Three adapters ignored it — one
 * even declared it in its signature and never read it. A user sets
 * reasoning_effort: 'high' for an o3 run, pays low-effort prices, and concludes
 * the prompt is the problem.
 */
describe('providerOptions reaches the wire on every provider', () => {
  for (const [name, adapter] of ADAPTERS) {
    it(`${name} forwards a provider-native passthrough key`, async () => {
      // A neutral marker: providerOptions is a RAW passthrough, so the contract
      // is "it reaches the request body", not any particular translation.
      // (OpenRouter additionally maps reasoning_effort -> reasoning.effort,
      // which is its own API shape and correct — so asserting that literal key
      // would have failed it for the wrong reason.)
      const body = await requestBody(name, adapter, { x_test_passthrough: 'yes' });
      expect(JSON.stringify(body)).toContain('x_test_passthrough');
    });
  }

  it('does not let providerOptions clobber the fields the engine controls', async () => {
    // model/messages/tools are the engine's; a passthrough must not rewrite them.
    const body = await requestBody('openai', new OpenAIAdapter(), { model: 'HIJACKED', messages: [] });
    expect(body.model).toBe('m');
    expect(Array.isArray(body.messages) && body.messages.length).toBeGreaterThan(0);
  });
});
