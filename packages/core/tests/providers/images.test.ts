import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'test-key', set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const IMAGE = [{ base64: B64, mimeType: 'image/png' }];

/** Minimal successful body per provider, so callAPI reaches the end. */
const OK_BODIES: Record<string, unknown> = {
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

/** Run callAPI against a stubbed fetch and return the request body it built. */
async function capture(name: string, adapter: any, images?: typeof IMAGE): Promise<string> {
  const original = globalThis.fetch;
  let sent = '';
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = String(init?.body ?? '');
    return { ok: true, status: 200, statusText: 'OK', json: async () => OK_BODIES[name], text: async () => '' } as any;
  }) as any;
  try {
    await adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'describe this', temperature: 0, maxTokens: 32, ...(images ? { images } : {}) });
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

/**
 * `image` is documented in docs/cli.md and README.md as a general test-case
 * field with no provider caveat. Three of the five adapters neither declared
 * nor read it, so the image never reached the wire, the model answered a
 * question it could not see, every candidate scored near zero, and nothing
 * anywhere said why.
 */
describe('every adapter actually sends the image it is given', () => {
  for (const [name, adapter] of ADAPTERS) {
    it(`${name}: the base64 payload reaches the request body`, async () => {
      const body = await capture(name, adapter, IMAGE);
      expect(body).toContain(B64);
    });

    it(`${name}: no image block when no image was given`, async () => {
      const body = await capture(name, adapter);
      expect(body).not.toContain(B64);
      expect(body).not.toMatch(/image_url|inlineData|"type":"image"/);
    });
  }

  it('uses each provider’s own image shape, not a shared guess', async () => {
    expect(await capture('anthropic', new AnthropicAdapter(), IMAGE))
      .toMatch(/"type":"image","source":\{"type":"base64","media_type":"image\/png"/);
    expect(await capture('gemini', new GeminiAdapter(), IMAGE))
      .toMatch(/"inlineData":\{"mimeType":"image\/png"/);
    expect(await capture('groq', new GroqAdapter(), IMAGE))
      .toMatch(/"type":"image_url","image_url":\{"url":"data:image\/png;base64,/);
  });

  it('keeps the prompt text alongside the image', async () => {
    for (const [name, adapter] of ADAPTERS) {
      expect(await capture(name, adapter, IMAGE)).toContain('describe this');
    }
  });
});
