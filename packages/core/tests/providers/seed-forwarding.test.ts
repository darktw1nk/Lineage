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

import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const RESPONSES: Record<string, any> = {
  openai: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
};

let lastBody: any;
function stubFetch(kind: keyof typeof RESPONSES) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify(RESPONSES[kind]), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastBody = undefined; });

const CALL = { model: 'm', prompt: 'IN', temperature: 0.5, maxTokens: 50 };

describe('provider seed forwarding', () => {
  it('gemini: seed lands in generationConfig', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call({ ...CALL, seed: 12345 });
    expect(lastBody.generationConfig.seed).toBe(12345);
  });

  it('gemini: no seed key when absent', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call(CALL);
    expect(lastBody.generationConfig.seed).toBeUndefined();
  });

  it('openrouter: seed in body', async () => {
    stubFetch('openai');
    await new OpenRouterAdapter().call({ ...CALL, seed: 12345 });
    expect(lastBody.seed).toBe(12345);
  });
});
