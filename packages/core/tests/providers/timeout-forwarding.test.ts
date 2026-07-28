import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'test-key-1234', set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/engine/semaphore.js', () => ({
  withGlobalSemaphore: (fn: any) => fn(),
  initGlobalSemaphore: vi.fn(),
  updateGlobalSemaphoreLimit: vi.fn(),
}));
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: async () => ({ provider: 'openai', model: 'm', promptUSDper1k: 0, completionUSDper1k: 0 }),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const RESPONSES: Record<string, any> = {
  openai: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  anthropic: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
};

let lastInit: any;
function stubFetch(kind: keyof typeof RESPONSES) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastInit = init;
    return new Response(JSON.stringify(RESPONSES[kind]), { status: 200 });
  }));
}

// Hang-until-aborted stub (honors the signal like real fetch)
function stubHangingFetch() {
  vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastInit = undefined; });

const CALL = { model: 'm', prompt: 'IN', temperature: 0.5, maxTokens: 50 };

describe('every adapter passes an AbortSignal', () => {
  const cases: Array<[string, any, keyof typeof RESPONSES]> = [
    ['openai', new OpenAIAdapter(), 'openai'],
    ['groq', new GroqAdapter(), 'openai'],
    ['openrouter', new OpenRouterAdapter(), 'openai'],
    ['anthropic', new AnthropicAdapter(), 'anthropic'],
    ['gemini', new GeminiAdapter(), 'gemini'],
  ];
  for (const [name, adapter, kind] of cases) {
    it(`${name}: fetch receives a signal`, async () => {
      stubFetch(kind);
      await adapter.call({ ...CALL, timeoutMs: 5000 });
      expect(lastInit.signal).toBeInstanceOf(AbortSignal);
    });
  }
});

describe('timeout actually fires and is retryable-then-fatal', () => {
  it('a hung request rejects with a timed-out error instead of hanging', async () => {
    stubHangingFetch();
    await expect(new OpenAIAdapter().call({ ...CALL, timeoutMs: 30 }))
      .rejects.toThrow(/timed out after 30ms/);
  }, 30000);
});
