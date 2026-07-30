import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'k', set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';

/**
 * `latencyMs` feeds the fitness latency dimension directly
 * (fitness.ts: latencyScore = (1 - latencyMs/maxLatency) * 10). Measuring from
 * before the retry loop folded every backoff SLEEP into the number, so one
 * transient 503 turned a genuinely 300ms candidate into a 3000ms one and
 * selection discarded a good prompt for a network hiccup.
 */
describe('latencyMs through call() measures the attempt, not the retries', () => {
  it('excludes backoff sleeps after transient failures', async () => {
    const adapter = new OpenAIAdapter();
    let attempt = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt < 3) {
        return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'busy' } as any;
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        text: async () => '',
      } as any;
    }) as any;
    try {
      const started = Date.now();
      const r = await adapter.call({ model: 'm', prompt: 'p', temperature: 0, maxTokens: 8 });
      const wall = Date.now() - started;

      expect(attempt).toBe(3);            // two retries really happened
      expect(wall).toBeGreaterThan(1000); // and they really slept
      // The reported latency must describe the CALL, not the outage.
      expect(r.latencyMs).toBeLessThan(500);
    } finally {
      globalThis.fetch = original;
    }
  }, 30000);

  it('still reports a real latency on a first-try success', async () => {
    const adapter = new OpenAIAdapter();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise(r => setTimeout(r, 60));
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        text: async () => '',
      } as any;
    }) as any;
    try {
      const r = await adapter.call({ model: 'm', prompt: 'p', temperature: 0, maxTokens: 8 });
      expect(r.latencyMs).toBeGreaterThanOrEqual(50);
    } finally {
      globalThis.fetch = original;
    }
  }, 30000);
});
