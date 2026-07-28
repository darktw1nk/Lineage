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

let lastBody: any;
function stubFetch(kind: keyof typeof RESPONSES) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify(RESPONSES[kind]), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastBody = undefined; });

const CALL = { model: 'm', prompt: 'USER INPUT', temperature: 0.5, maxTokens: 50 };

describe('system-role placement', () => {
  it('openai: system message prepended', async () => {
    stubFetch('openai');
    await new OpenAIAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
    expect(lastBody.messages[1].role).toBe('user');
  });

  it('openai: payload unchanged when system absent', async () => {
    stubFetch('openai');
    await new OpenAIAdapter().call(CALL);
    expect(lastBody.messages).toHaveLength(1);
    expect(lastBody.messages[0].role).toBe('user');
  });

  it('groq: system message prepended', async () => {
    stubFetch('openai');
    await new GroqAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
  });

  it('openrouter: system message prepended', async () => {
    stubFetch('openai');
    await new OpenRouterAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
  });

  it('anthropic: top-level system parameter', async () => {
    stubFetch('anthropic');
    await new AnthropicAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.system).toBe('SYS PROMPT');
    expect(lastBody.messages[0].role).toBe('user');
  });

  it('gemini: systemInstruction', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.systemInstruction).toEqual({ parts: [{ text: 'SYS PROMPT' }] });
    expect(lastBody.contents[0].parts[0].text).toBe('USER INPUT');
  });

  it('gemini: no systemInstruction key when absent', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call(CALL);
    expect(lastBody.systemInstruction).toBeUndefined();
  });
});
