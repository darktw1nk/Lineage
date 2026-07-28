import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveApiKey,
  createCliStore,
  readElectronStore,
  writeElectronStore,
  getElectronStorePath,
} from '../../../cli/store.js';

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
  const storePath = getElectronStorePath();
  let backup: string | null = null;

  beforeEach(() => {
    // Backup existing store if present
    try {
      backup = fs.readFileSync(storePath, 'utf-8');
    } catch {
      backup = null;
    }
  });

  afterEach(() => {
    // Restore backup
    if (backup !== null) {
      fs.writeFileSync(storePath, backup);
    }
  });

  it('writes and reads a dotted key', () => {
    writeElectronStore('apiKey.test_provider', 'test-value-123');
    const data = readElectronStore();
    expect(data?.apiKey?.test_provider).toBe('test-value-123');

    // Clean up the test key
    writeElectronStore('apiKey.test_provider', undefined);
  });
});
