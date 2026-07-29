import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { getProviderAdapter } from '../../src/providers/index.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

let inFlight = 0;
let peak = 0;

/** A PLAIN OBJECT adapter — the shape docs/plugins.md documents. */
function registerPlainPlugin() {
  registerProvider({
    adapter: {
      name: 'plainp',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 15));
        inFlight--;
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      },
    } as any,
  });
}

beforeEach(() => { resetRegistry(); inFlight = 0; peak = 0; });

describe('plugin providers obey parallelLimit', () => {
  it('is bounded by the global semaphore', async () => {
    // withGlobalSemaphore had exactly one call site — inside
    // BaseProviderAdapter.call — so plain-object plugin adapters bypassed it
    // entirely. docs/cli.md calls parallelLimit "maximum concurrent API
    // calls"; measured peak for a plugin was parallelLimit x testSet.length,
    // and samplesPerTest multiplies it again. A modest 8/20/5 config opens 800
    // concurrent requests against a third-party API or a local server.
    initGlobalSemaphore(3);
    registerPlainPlugin();
    const adapter = getProviderAdapter('plainp' as any);
    await Promise.all(Array.from({ length: 20 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0 } as any)));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // still concurrent, just bounded
  }, 30000);

  it('keeps the rest of the adapter intact through the wrapper', async () => {
    initGlobalSemaphore(4);
    registerPlainPlugin();
    const adapter = getProviderAdapter('plainp' as any);
    expect(adapter.name).toBe('plainp');
    expect(adapter.estimateTokens('abcd')).toEqual({ prompt: 1 });
    const r = await adapter.call({ model: 'm', prompt: 'p', temperature: 0 } as any);
    expect(r.output).toBe('x');
  }, 30000);
});
