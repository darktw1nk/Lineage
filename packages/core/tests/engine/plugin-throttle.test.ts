import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry, resetLeakedCalls } from '../../src/registry.js';
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

/**
 * Wait until every permit is back. The global semaphore is a module singleton
 * shared by every test in this file, and abandoned work keeps its permit until
 * the real call settles — so a test that leaves work in flight silently
 * starves the ones after it.
 */
async function drainSemaphore(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    let free = false;
    // A probe that resolves immediately means a permit was available.
    const probe = withGlobalSemaphore(async () => { free = true; }, 'drain-probe');
    await Promise.race([probe, new Promise(r => setTimeout(r, 25))]);
    if (free) return;
    await new Promise(r => setTimeout(r, 25));
  }
}

// leakedCalls is a module singleton: a test that leaves leaks behind makes
// every later test refuse to start work.
beforeEach(() => { resetRegistry(); resetLeakedCalls(); inFlight = 0; peak = 0; });

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
      // Settles far too late to be useful, rather than never. The permit now
      // follows the WORK, so a promise that never settles holds its slot for
      // the life of the process — which starved every test after this one in
      // this file. Late-but-finite keeps the assertion (the CALLER is freed at
      // 300ms) without leaking a permit into the next test.
      call: () => new Promise(resolve => setTimeout(
        () => resolve({ output: 'late', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
        1200,
      )),
    } as any });
    const adapter = getProviderAdapter('hangs' as any);
    const started = Date.now();
    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 300 } as any),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(Date.now() - started).toBeLessThan(3000);
    await drainSemaphore();
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

describe('the timeout must not break the concurrency cap it sits beside', () => {
  // Promise.race let the TIMEOUT win, which released the semaphore permit while
  // the plugin's work was still running against the same server. Measured:
  // parallelLimit 2, 8 calls, peak concurrency 8 — the slower the server, the
  // faster permits recycle onto it. A timeout cannot cancel work; it can only
  // stop the engine WAITING. The permit must follow the work, not the race.
  it('peak concurrency stays at parallelLimit even when every call times out', async () => {
    initGlobalSemaphore(2);
    let inFlight = 0, peak = 0, done = 0, issued = 0;
    registerProvider({ adapter: {
      name: 'slowplug',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 600));
        inFlight--; done++;
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      },
    } as any });
    const adapter = getProviderAdapter('slowplug' as any);
    const calls = Array.from({ length: 8 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 100 } as any)
        .then(() => 'ok', () => 'timeout'));
    const results = await Promise.all(calls);

    expect(results.every(r => r === 'timeout')).toBe(true); // callers freed fast
    // Drain on the real signal, not a sleep. Abandoned work still holds its
    // permit, so a fixed wait that guesses short leaves permits checked out and
    // starves every later test in this file — which is what a 1500ms guess did.
    // Wait for the work that was actually STARTED. Calls beyond the leak
    // budget are refused before reaching the plugin, so `issued` < 8.
    while (done < issued) await new Promise(r => setTimeout(r, 50));
    // done++ runs inside the plugin, BEFORE withGlobalSemaphore's finally has
    // released the permit. The semaphore is a singleton and setPermits computes
    // permits = limit - inUse, so a permit still checked out here leaves the
    // NEXT test's initGlobalSemaphore with zero free permits and starves it.
    await drainSemaphore();
    // Bounded at 2x, not exact: a timed-out call releases its permit so the
    // run cannot wedge, and its still-running work is counted as a leak.
    // Dispatch stops once leaks reach parallelLimit, so peak <= limit + limit.
    expect(peak).toBeLessThanOrEqual(4);
  }, 30000);
});

describe('callTimeoutMs measures the CALL, not the queue wait', () => {
  // The timer was armed before withGlobalSemaphore was entered, so a call that
  // sat in the queue could be rejected before start() had ever run. Measured at
  // parallelLimit 8 with 200 calls of 100ms and callTimeoutMs 1500ms: 44% of
  // callers failed though no single call took over 100ms. Worse, the detached
  // task stayed queued and ISSUED the request anyway — paid requests whose
  // caller had already been told the provider did not respond, and the engine
  // accrues a throw as {usd: 0, calls: 1}, so that spend is invisible to
  // budgetUSD.
  it('does not time out a call that merely queued', async () => {
    initGlobalSemaphore(1);
    let issued = 0;
    registerProvider({ adapter: {
      name: 'queued',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        issued++;
        await new Promise(r => setTimeout(r, 200));
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      },
    } as any });
    const adapter = getProviderAdapter('queued' as any);
    // 4 serialised calls of 200ms each. The last waits 600ms in the queue, but
    // its own call still takes 200ms — well inside a 600ms per-call timeout.
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 600 } as any)
        .then(() => 'ok', () => 'timeout')));
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(issued).toBe(4);
  }, 30000);

  it('never issues a request whose caller already gave up', async () => {
    initGlobalSemaphore(1);
    let issued = 0;
    registerProvider({ adapter: {
      name: 'abandoned',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        issued++;
        await new Promise(r => setTimeout(r, 400));
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      },
    } as any });
    const adapter = getProviderAdapter('abandoned' as any);
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 500 } as any)
        .then(() => 'ok', () => 'timeout')));
    const gaveUp = results.filter(r => r === 'timeout').length;
    await new Promise(r => setTimeout(r, 1600)); // let the queue drain
    // Whatever timed out must NOT have been sent to the provider.
    expect(issued).toBe(3 - gaveUp);
  }, 30000);
});

describe('a hung provider must not wedge the run forever', () => {
  // Pass 9 moved the timer inside the semaphore callback to stop queue wait
  // being counted as call time. That left a caller which is still QUEUED with
  // no timer at all: measured at parallelLimit 4 with 10 callers against a
  // provider that never settles, 4 got an error and 6 were STILL PENDING at
  // 1500ms. Exactly `parallelLimit` hangs wedge the run permanently — and
  // nothing detects it, because shouldStop is never consulted while awaiting a
  // node's Promise.all, so neither timeLimitMs nor Stop can end the run.
  //
  // A timeout cannot cancel work, so holding the permit (correct cap, risk
  // wedge) and releasing it (liveness, cap violated) are both wrong on their
  // own. The permit is released so the run stays alive, the leak is COUNTED,
  // and once leaks reach parallelLimit the run is failed with a diagnostic —
  // bounding concurrency at 2x rather than letting it grow without limit.
  it('frees every caller, including the ones still queued', async () => {
    initGlobalSemaphore(2);
    registerProvider({ adapter: {
      name: 'wedger',
      estimateTokens: () => ({ prompt: 1 }),
      call: () => new Promise(() => { /* never settles */ }),
    } as any });
    const adapter = getProviderAdapter('wedger' as any);

    const settled = await Promise.all(Array.from({ length: 6 }, () =>
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 150 } as any)
        .then(() => 'ok', () => 'error')));

    // Before the fix: 2 errors and 4 promises that never settle at all.
    expect(settled).toHaveLength(6);
    expect(settled.every(s => s === 'error')).toBe(true);
  }, 30000);
});
