import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

/**
 * A reply the TOKEN CAP ended is not a bad reply, but every scorer downstream
 * treats it as one: a json_schema test on a cut-off answer scored 0/10 with
 * "invalid JSON: no parseable JSON found in the response", naming nothing.
 * The user then rewrites their prompt to fix a config setting.
 */
function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
}

const CASES: Array<{
  name: string;
  adapter: any;
  truncated: unknown;
  complete: unknown;
}> = [
  {
    name: 'openai', adapter: new OpenAIAdapter(),
    truncated: { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    complete: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  },
  {
    name: 'groq', adapter: new GroqAdapter(),
    truncated: { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    complete: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  },
  {
    name: 'openrouter', adapter: new OpenRouterAdapter(),
    truncated: { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    complete: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  },
  {
    name: 'anthropic', adapter: new AnthropicAdapter(),
    truncated: { content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } },
    complete: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  },
  {
    name: 'gemini', adapter: new GeminiAdapter(),
    truncated: { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    complete: { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
  },
];

describe('every adapter reports when the token cap ended the reply', () => {
  for (const c of CASES) {
    it(`${c.name}: truncated === true when the cap was hit`, async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => jsonResponse(c.truncated)) as any;
      try {
        const r = await c.adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 5 });
        expect(r.truncated).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    });

    it(`${c.name}: truncated === false on a normal stop`, async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => jsonResponse(c.complete)) as any;
      try {
        const r = await c.adapter.callAPI({ apiKey: 'k', model: 'm', prompt: 'p', temperature: 0, maxTokens: 5 });
        expect(r.truncated).toBe(false);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});
