import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS, RetryableError } from '../../src/providers/retry.js';

// Hang-until-aborted stub: never resolves, but honors the abort signal like real fetch
function hangingFetch() {
  return vi.fn((_url: any, init: any) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchWithTimeout', () => {
  it('aborts a hung request and rethrows as RetryableError(408)', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const started = Date.now();
    await expect(fetchWithTimeout('https://x.test', { method: 'POST' }, 50))
      .rejects.toSatisfy((e: any) =>
        e instanceof RetryableError && e.statusCode === 408 && /timed out after 50ms/.test(e.message));
    expect(Date.now() - started).toBeLessThan(2000); // aborted promptly, not hung
  });

  it('passes a successful response through and forwards the signal', async () => {
    let seenInit: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      seenInit = init;
      return new Response('{"ok":true}', { status: 200 });
    }));
    const res = await fetchWithTimeout('https://x.test', { method: 'GET' }, 5000);
    expect(res.status).toBe(200);
    expect(seenInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('rethrows non-abort errors untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(fetchWithTimeout('https://x.test', {}, 5000)).rejects.toThrow(TypeError);
  });

  it('exports the 120s default', () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(120_000);
  });
});
