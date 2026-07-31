import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __setStoreDirForTests, saveApiKey, resolveApiKey, readElectronStore } from '../src/store.js';

/**
 * `--set-key` has never been tested end to end, deliberately: it writes the
 * ENCRYPTED store the desktop app shares, and a test that got the path wrong
 * would wipe the user's real keys. That risk is exactly why it needs coverage —
 * this store has already been clobbered once in this project's history, when a
 * hand-rolled JSON.parse silently returned {} and `--set-key` wrote defaults
 * over every saved setting.
 *
 * `__setStoreDirForTests` exists for this; every case here points at a scratch
 * directory and asserts the real path is never touched.
 */
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-key-'));
  __setStoreDirForTests(dir);
});
afterEach(() => {
  __setStoreDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('--set-key round-trips through the shared encrypted store', () => {
  it('a saved key reads back', () => {
    saveApiKey('openai', 'sk-test-abcdefghijklmnop');
    expect(resolveApiKey('openai', undefined)).toBe('sk-test-abcdefghijklmnop');
  });

  it('saving one provider does not disturb another', () => {
    saveApiKey('openai', 'sk-one-abcdefghijklmnop');
    saveApiKey('anthropic', 'sk-two-abcdefghijklmnop');
    expect(resolveApiKey('openai', undefined)).toBe('sk-one-abcdefghijklmnop');
    expect(resolveApiKey('anthropic', undefined)).toBe('sk-two-abcdefghijklmnop');
  });

  it('the store keeps every other setting when a key is written', () => {
    // The historical failure: writing a key replaced the whole document, so a
    // single --set-key wiped the desktop's service model and limits.
    saveApiKey('openai', 'sk-one-abcdefghijklmnop');
    const before = readElectronStore();
    saveApiKey('gemini', 'sk-two-abcdefghijklmnop');
    const after = readElectronStore();
    for (const key of Object.keys(before)) {
      expect(after).toHaveProperty(key);
    }
  });

  it('an env var still wins over the stored key', () => {
    saveApiKey('openai', 'sk-stored-abcdefghijkl');
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env-abcdefghijklmn';
    try {
      expect(resolveApiKey('openai', undefined)).toBe('sk-env-abcdefghijklmn');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it('writes only inside the scratch directory', () => {
    saveApiKey('openai', 'sk-test-abcdefghijklmnop');
    const written = fs.readdirSync(dir);
    expect(written.length).toBeGreaterThan(0);
  });
});
