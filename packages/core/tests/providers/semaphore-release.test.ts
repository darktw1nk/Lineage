import { it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'test-key-1234', set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: async () => ({ provider: 'openai', model: 'm', promptUSDper1k: 0, completionUSDper1k: 0 }),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

afterEach(() => vi.unstubAllGlobals());

it('a timed-out call releases its semaphore slot (follow-up call runs)', async () => {
  initGlobalSemaphore(1); // single slot: a leak would deadlock the second call
  let mode: 'hang' | 'ok' = 'hang';
  vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => {
    if (mode === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(new Response(JSON.stringify(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
  }));

  const adapter = new OpenAIAdapter();
  await expect(adapter.call({ model: 'm', prompt: 'IN', temperature: 0, maxTokens: 10, timeoutMs: 30 }))
    .rejects.toThrow(/timed out/); // exhausts retries (~7s of real backoff)

  mode = 'ok';
  const result = await adapter.call({ model: 'm', prompt: 'IN', temperature: 0, maxTokens: 10, timeoutMs: 5000 });
  expect(result.output).toBe('ok'); // slot was freed — no deadlock
}, 30000);
