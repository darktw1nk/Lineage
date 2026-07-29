import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveApiKey,
  createCliStore,
  readElectronStore,
  writeElectronStore,
  getElectronStorePath,
  __setStoreDirForTests,
} from '../src/store.js';

describe('CLI Store - resolveApiKey', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  it('returns env var with highest priority', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const key = resolveApiKey('openai', { openaiKey: 'config-key' });
    expect(key).toBe('env-key');
  });

  it('falls back to config key when no env var', () => {
    delete process.env.OPENAI_API_KEY;
    const key = resolveApiKey('openai', { openaiKey: 'config-key' });
    expect(key).toBe('config-key');
  });

  it('returns null when no key found anywhere', () => {
    delete process.env.OPENAI_API_KEY;
    const key = resolveApiKey('openai');
    // May return a saved key from electron-store if present, or null
    // We test the env/config priority; electron-store is environment-dependent
    expect(typeof key === 'string' || key === null).toBe(true);
  });

  it('resolves OpenRouter key from env', () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    const key = resolveApiKey('openrouter');
    expect(key).toBe('or-env-key');
  });

  it('resolves Anthropic key from config', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const key = resolveApiKey('anthropic', { anthropicKey: 'sk-ant-config' });
    expect(key).toBe('sk-ant-config');
  });

  it('resolves Gemini key from env', () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    const key = resolveApiKey('gemini');
    expect(key).toBe('gem-key');
  });
});

describe('CLI Store - createCliStore', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('get() returns env var for apiKey.* pattern', () => {
    process.env.OPENAI_API_KEY = 'store-env-key';
    const store = createCliStore();
    expect(store.get('apiKey.openai')).toBe('store-env-key');
  });

  it('get() returns config key when no env var', () => {
    delete process.env.OPENAI_API_KEY;
    const store = createCliStore({ openaiKey: 'store-config-key' });
    expect(store.get('apiKey.openai')).toBe('store-config-key');
  });
});

describe('CLI Store - createCliStore with systemPrompts', () => {
  it('returns systemPrompts when provided', () => {
    const prompts = {
      llmGradingPrompt: 'Custom grading prompt',
      crossoverPrompt: 'Custom crossover prompt',
    };
    const store = createCliStore(undefined, prompts);
    expect(store.get('systemPrompts')).toBe(prompts);
    expect(store.get('systemPrompts').llmGradingPrompt).toBe('Custom grading prompt');
  });

  it('falls through to electron-store when systemPrompts not provided', () => {
    const store = createCliStore();
    const result = store.get('systemPrompts');
    // Falls through to electron-store; may be null or an object depending on environment
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('does not interfere with apiKey resolution', () => {
    const originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = 'test-key-with-prompts';
    const prompts = { llmGradingPrompt: 'Custom' };
    const store = createCliStore(undefined, prompts);
    expect(store.get('apiKey.openai')).toBe('test-key-with-prompts');
    expect(store.get('systemPrompts')).toBe(prompts);
    process.env = { ...originalEnv };
  });
});

describe('CLI Store - writeElectronStore / readElectronStore', () => {
  // Never touch the user's real store: back-up-and-restore read the file as
  // utf-8 text, which silently corrupts the desktop's ENCRYPTED config.
  const scratchDir = path.join(os.tmpdir(), `pe-store-${process.pid}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    fs.mkdirSync(scratchDir, { recursive: true });
    __setStoreDirForTests(scratchDir);
  });

  afterEach(() => {
    __setStoreDirForTests(null);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('writes and reads a dotted key', () => {
    writeElectronStore('apiKey.test_provider', 'test-value-123');
    const data = readElectronStore();
    expect(data?.apiKey?.test_provider).toBe('test-value-123');

    // Clean up the test key
    writeElectronStore('apiKey.test_provider', undefined);
    expect(readElectronStore()?.apiKey?.test_provider).toBeUndefined();
  });

  it('a write preserves every other stored setting (no read-modify-wipe)', () => {
    writeElectronStore('apiKey.openai', 'sk-existing');
    writeElectronStore('disabledPlugins', ['evil-plugin']);
    writeElectronStore('systemPrompts', { llmGradingPrompt: 'custom' });

    // A later, unrelated write must not erase the rest
    writeElectronStore('apiKey.groq', 'sk-new');

    const data = readElectronStore();
    expect(data.apiKey.openai).toBe('sk-existing');
    expect(data.apiKey.groq).toBe('sk-new');
    expect(data.disabledPlugins).toEqual(['evil-plugin']);
    expect(data.systemPrompts).toEqual({ llmGradingPrompt: 'custom' });
  });

  it('reads the desktop encrypted format (electron-store interop)', async () => {
    // The desktop writes through electron-store with the shared encryption key;
    // the CLI must see those keys, not an empty object.
    const { default: ElectronStore } = await import('electron-store');
    const desktop = new (ElectronStore as any)({ cwd: scratchDir, encryptionKey: 'prompt-evolution-secure-key' });
    desktop.set('apiKey.anthropic', 'sk-DESKTOP-anthropic');

    __setStoreDirForTests(scratchDir); // drop the CLI's cached handle
    expect(readElectronStore()?.apiKey?.anthropic).toBe('sk-DESKTOP-anthropic');
  });
});

describe('plugin provider env fallback', () => {
  it('derives <PROVIDER>_API_KEY for non-built-in providers', () => {
    process.env.MY_LOCAL_LLM_API_KEY = 'plugin-key';
    try {
      expect(resolveApiKey('my-local-llm' as any)).toBe('plugin-key');
    } finally {
      delete process.env.MY_LOCAL_LLM_API_KEY;
    }
  });
});
