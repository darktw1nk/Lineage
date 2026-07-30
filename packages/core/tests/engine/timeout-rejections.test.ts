import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerProvider } from '../../src/registry.js';
import { getProviderAdapter } from '../../src/providers/index.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

/**
 * callWithTimeout hands the caller a promise that rejects on timeout while a
 * DETACHED semaphore task keeps awaiting the real work. Detached chains are
 * where unhandled rejections come from: if the plugin later rejects, its
 * rejection must land on the caller's already-settled promise, not on the
 * process. An unhandled rejection kills the Electron main process outright.
 */
const unhandled: unknown[] = [];
const trap = (r: unknown) => { unhandled.push(r); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', trap); });
afterEach(() => { process.off('unhandledRejection', trap); });

describe('the timeout path leaks no unhandled rejection', () => {
  it('survives work that rejects AFTER the caller gave up', async () => {
    initGlobalSemaphore(4);
    registerProvider({ adapter: {
      name: 'latefail',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        await new Promise(r => setTimeout(r, 300));
        throw new Error('plugin failed long after the timeout');
      },
    } as any });

    const adapter = getProviderAdapter('latefail' as any);
    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 50 } as any),
    ).rejects.toThrow(/callTimeoutMs/);

    await new Promise(r => setTimeout(r, 600)); // let the abandoned work reject
    expect(unhandled).toEqual([]);
  }, 20000);

  it('survives work that RESOLVES after the caller gave up', async () => {
    initGlobalSemaphore(4);
    registerProvider({ adapter: {
      name: 'lateok',
      estimateTokens: () => ({ prompt: 1 }),
      call: async () => {
        await new Promise(r => setTimeout(r, 300));
        return { output: 'x', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
      },
    } as any });

    const adapter = getProviderAdapter('lateok' as any);
    await expect(
      adapter.call({ model: 'm', prompt: 'p', temperature: 0, timeoutMs: 50 } as any),
    ).rejects.toThrow(/callTimeoutMs/);

    await new Promise(r => setTimeout(r, 600));
    expect(unhandled).toEqual([]);
  }, 20000);
});
