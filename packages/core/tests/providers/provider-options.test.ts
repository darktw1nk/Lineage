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

  /**
   * The no-clobber contract was asserted on OpenAI ALONE while the passthrough
   * test looped all five, so two adapters diverged from the comment written
   * directly above their own spread. groq.ts and openrouter.ts applied
   * providerOptions LAST, letting a global `temperature` silently disable the
   * param operator's temperature evolution and a stray `model` break cost
   * accounting by billing one model's calls against another's price.
   */
  // Where each provider's request actually carries the engine's own fields.
  // Gemini takes the model from the URL and nests sampling under
  // generationConfig, so reading them off the top level would pass vacuously.
  const EFFECTIVE: Record<string, (b: any) => { model?: unknown; temperature: unknown }> = {
    openai: b => ({ model: b.model, temperature: b.temperature }),
    anthropic: b => ({ model: b.model, temperature: b.temperature }),
    groq: b => ({ model: b.model, temperature: b.temperature }),
    openrouter: b => ({ model: b.model, temperature: b.temperature }),
    gemini: b => ({ temperature: b.generationConfig?.temperature }),
  };

  for (const [name, adapter] of ADAPTERS) {
    it(`${name} keeps the engine's model and temperature against a hostile passthrough`, async () => {
      const body = await requestBody(name, adapter, {
        model: 'HIJACKED', temperature: 0.111, max_tokens: 7,
      });
      const eff = EFFECTIVE[name](body);
      if ('model' in eff) expect(eff.model).toBe('m');
      expect(eff.temperature).toBe(0);
    });
  }

  it('gemini MERGES generationConfig instead of discarding it', async () => {
    // generationConfig was spread first and then overwritten wholesale, so
    // topP/topK/thinkingConfig/responseMimeType — every knob that matters on
    // Gemini — were silently dropped. Gemini rejects them at the top level, so
    // there was no way to set them at all.
    const body = await requestBody('gemini', new GeminiAdapter(), {
      generationConfig: { topP: 0.5, thinkingConfig: { thinkingBudget: 128 } },
    });
    expect(body.generationConfig.topP).toBe(0.5);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128 });
    expect(body.generationConfig.temperature).toBe(0);   // engine still wins
    expect(body.generationConfig.maxOutputTokens).toBe(8);
  });
});

describe('a passthrough named like an Object.prototype member survives', () => {
  // `key in body` walks the prototype chain, so a passthrough called
  // toString/constructor/valueOf was silently dropped. Mutation testing found
  // reverting hasOwnProperty to `in` left the whole suite green.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    'openrouter forwards %s', async (key) => {
      const body = await requestBody('openrouter', new OpenRouterAdapter(), { [key]: 'passthrough-value' });
      expect(body[key]).toBe('passthrough-value');
    },
  );

  it('still refuses to let one clobber an engine field', async () => {
    const body = await requestBody('openrouter', new OpenRouterAdapter(), { model: 'HIJACKED' });
    expect(body.model).toBe('m');
  });
});
