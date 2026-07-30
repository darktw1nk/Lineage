import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { getProviderAdapter } from '../../src/providers/index.js';
import { initGlobalSemaphore, withGlobalSemaphore } from '../../src/engine/semaphore.js';
import { BaseProviderAdapter } from '../../src/providers/base.js';

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

describe('the throttle wrapper cannot deadlock a run', () => {
  // registry.ts guards double-wrapping with `instanceof BaseProviderAdapter`,
  // which three reachable plugin shapes defeat. Each one then acquires the
  // 1-permit-per-slot semaphore twice for a single logical call, and
  // Semaphore.acquire() has no timeout — callTimeoutMs is never reached, so the
  // run hangs FOREVER with no error and no way out but killing the process.
  const ranTo = async (p: Promise<unknown>, ms: number) => {
    let timer: any;
    const timeout = new Promise(r => { timer = setTimeout(() => r('DEADLOCK'), ms); });
    try { return await Promise.race([p.then(() => 'ok'), timeout]); }
    finally { clearTimeout(timer); }
  };

  it('a plugin that calls withGlobalSemaphore itself still completes', async () => {
    initGlobalSemaphore(1);
    registerProvider({ adapter: {
      name: 'selfsem',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => withGlobalSemaphore(async () => ({
        output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0,
      })),
    } as any });
    const adapter = getProviderAdapter('selfsem' as any);
    expect(await ranTo(adapter.call({ model: 'm', prompt: 'p', temperature: 0 } as any), 2500)).toBe('ok');
  }, 30000);

  it('a plugin that delegates to a built-in adapter still completes', async () => {
    // A router / fallback plugin — the built-in it calls acquires internally.
    initGlobalSemaphore(1);
    registerProvider({ adapter: {
      name: 'router',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => new (class extends BaseProviderAdapter {
        name = 'inner' as any;
        estimateTokens() { return { prompt: 1 }; }
        async callAPI() { return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1 }; }
        async getApiKey() { return 'k'; }
      })().call(opts),
    } as any });
    const adapter = getProviderAdapter('router' as any);
    expect(await ranTo(adapter.call({ model: 'm', prompt: 'p', temperature: 0 } as any), 2500)).toBe('ok');
  }, 30000);

  it('deadlocks at any parallelLimit once that many calls are in flight', async () => {
    initGlobalSemaphore(4);
    registerProvider({ adapter: {
      name: 'selfsem4',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => withGlobalSemaphore(async () => {
        await new Promise(r => setTimeout(r, 5));
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      }),
    } as any });
    const adapter = getProviderAdapter('selfsem4' as any);
    const all = Promise.all(Array.from({ length: 4 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0 } as any)));
    expect(await ranTo(all, 2500)).toBe('ok');
  }, 30000);
});

describe('callTimeoutMs is enforced for plugin adapters too', () => {
  // docs/cli.md promises callTimeoutMs 'aborts any single LLM HTTP attempt
  // after that long — a hung request is retried with a fresh budget instead of
  // stalling a parallel slot forever'. Built-ins honour it via fetchWithTimeout;
  // a plugin adapter is arbitrary code and the shipped Ollama example ignores
  // the option entirely, so a hung local server stalled the run indefinitely.
  it('a plugin that ignores timeoutMs is still aborted', async () => {
    initGlobalSemaphore(4);
    registerProvider({ adapter: {
      name: 'hangs',
      estimateTokens: () => ({ prompt: 1 }),
      call: () => new Promise(() => { /* never resolves, never reads timeoutMs */ }),
    } as any });
    const adapter = getProviderAdapter('hangs' as any);
    const started = Date.now();
    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 300 } as any),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 30000);

  it('a plugin that answers in time is untouched', async () => {
    initGlobalSemaphore(4);
    registerProvider({ adapter: {
      name: 'quick',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => ({ output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
    } as any });
    const r = await getProviderAdapter('quick' as any)
      .call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 300 } as any);
    expect(r.output).toBe('x');
  }, 30000);
});
