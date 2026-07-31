import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry, resetLeakedCalls } from '../../src/registry.js';
import { getProviderAdapter } from '../../src/providers/index.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

/**
 * Gaps mutation testing found in registry.ts (hunt 13).
 *
 * plugin-throttle.test.ts covers the leak BUDGET but never the leak
 * ACCOUNTING; the "absurd callTimeoutMs" test uses an adapter that resolves on
 * the microtask queue, so it beats even a 1ms timer and passes with the 32-bit
 * clamp deleted; and `timeoutMs: 0` is never exercised at all.
 */

const slowAdapter = (name: string, ms: number) => ({
  name,
  estimateTokens: () => ({ prompt: 1 }),
  call: () => new Promise(resolve => setTimeout(
    () => resolve({ output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }), ms,
  )),
});

beforeEach(() => { resetRegistry(); resetLeakedCalls(); });

describe('an absurd callTimeoutMs really is treated as "effectively never"', () => {
  // The existing test uses an adapter that resolves immediately, so its promise
  // settles on the MICROTASK queue — before any macrotask timer, including the
  // 1ms one Node substitutes for an overflowed delay. It therefore passes with
  // the 32-bit clamp removed, which is the whole bug: a 25-day timeout became an
  // INSTANT one and failed every call that took longer than a tick.
  it.each([2_147_483_648, 8.64e7 * 1000, Number.MAX_SAFE_INTEGER])(
    'timeoutMs %s does not abort a call that takes real time', async (timeoutMs) => {
      initGlobalSemaphore(4);
      registerProvider({ adapter: slowAdapter('slowbig', 60) as any });
      const r = await getProviderAdapter('slowbig' as any)
        .call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs } as any);
      expect(r.output).toBe('x');
    }, 20000,
  );
});

describe('timeoutMs 0 means "no timeout", not "abort immediately"', () => {
  it('a zero timeout lets a slow call finish', async () => {
    // Built-in adapters read 0 as "fall back to the 120s default"
    // (`opts.timeoutMs && opts.timeoutMs > 0 ? ... : DEFAULT`), and the desktop
    // Call Timeout field produces exactly 0 when you type 0. Weakening the
    // plugin guard from `<= 0` to `< 0` arms setTimeout(…, 0) and every plugin
    // call is rejected before it can return.
    initGlobalSemaphore(4);
    registerProvider({ adapter: slowAdapter('zerot', 60) as any });
    const r = await getProviderAdapter('zerot' as any)
      .call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 0 } as any);
    expect(r.output).toBe('x');
  }, 20000);
});

describe('a leaked call is forgiven once it settles', () => {
  // `leakedCalls` bounds how far concurrency may exceed parallelLimit, and once
  // it reaches the budget the registry REFUSES to start any further call. The
  // decrements in the settle handlers are what make that recoverable. Deleting
  // either one survives the suite — plugin-throttle.test.ts calls
  // resetLeakedCalls() in beforeEach, so the permanent poisoning never shows —
  // and a provider that is briefly slow then kills the run for good.

  it('a late RESOLVE releases the leak, so the next call still runs', async () => {
    initGlobalSemaphore(1); // leak budget = 1
    registerProvider({ adapter: slowAdapter('lateok2', 250) as any });
    const adapter = getProviderAdapter('lateok2' as any);

    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 60 } as any),
    ).rejects.toThrow(/callTimeoutMs|timed out/i);

    await new Promise(r => setTimeout(r, 500)); // the abandoned work settles

    const r = await adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 5000 } as any);
    expect(r.output).toBe('x');
  }, 20000);

  it('a late REJECT releases the leak too', async () => {
    initGlobalSemaphore(1);
    let attempt = 0;
    registerProvider({ adapter: {
      name: 'latefail2',
      estimateTokens: () => ({ prompt: 1 }),
      call: () => new Promise((resolve, reject) => setTimeout(() => {
        if (attempt++ === 0) reject(new Error('provider died'));
        else resolve({ output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 });
      }, 250)),
    } as any });
    const adapter = getProviderAdapter('latefail2' as any);

    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 60 } as any),
    ).rejects.toThrow(/callTimeoutMs|timed out/i);

    await new Promise(r => setTimeout(r, 500));

    const r = await adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 5000 } as any);
    // The refusal message is the tell: "has N call(s) that never returned".
    expect(r.output).toBe('x');
  }, 20000);
});

describe('declared plugin prices must be non-negative', () => {
  it('a negative prompt price is refused at registration', () => {
    // OpenRouter publishes "-1" as a "price varies" sentinel, so a plugin that
    // mirrors an upstream catalogue can carry one through. A negative price
    // produces negative spend, which inverts fitness and lets totals.usd run
    // AWAY from budgetUSD so the cap can never trip.
    expect(() => registerProvider({
      adapter: { name: 'negp', estimateTokens: () => ({ prompt: 1 }), call: async () => ({}) } as any,
      models: [{ provider: 'negp', model: 'm', promptUSDper1k: -1, completionUSDper1k: 0 }],
    })).toThrow(/invalid model entry/i);
  });

  it('a negative completion price is refused at registration', () => {
    expect(() => registerProvider({
      adapter: { name: 'negc', estimateTokens: () => ({ prompt: 1 }), call: async () => ({}) } as any,
      models: [{ provider: 'negc', model: 'm', promptUSDper1k: 0, completionUSDper1k: -0.5 }],
    })).toThrow(/invalid model entry/i);
  });

  it('a genuinely free model (0/0) is still accepted', () => {
    expect(() => registerProvider({
      adapter: { name: 'freep', estimateTokens: () => ({ prompt: 1 }), call: async () => ({}) } as any,
      models: [{ provider: 'freep', model: 'm', promptUSDper1k: 0, completionUSDper1k: 0 }],
    })).not.toThrow();
  });
});
