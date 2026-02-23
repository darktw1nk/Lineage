import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock the store (used for API key retrieval)
vi.mock('../../../electron/store.js', () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === 'apiKey.openai') return 'sk-test-openai';
      if (key === 'apiKey.anthropic') return 'sk-test-anthropic';
      if (key === 'apiKey.gemini') return 'sk-test-gemini';
      return null;
    }),
  },
}));

// Mock costs (used for USD calculation)
vi.mock('../../../electron/providers/costs.js', () => ({
  getModelCost: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4',
    promptUSDper1k: 0.03,
    completionUSDper1k: 0.06,
  }),
}));

// Mock semaphore (wraps calls)
vi.mock('../../../electron/engine/semaphore.js', () => ({
  withGlobalSemaphore: vi.fn((fn: () => any) => fn()),
}));

import { OpenAIAdapter } from '../../../electron/providers/openai';
import { AnthropicAdapter } from '../../../electron/providers/anthropic';
import { GeminiAdapter } from '../../../electron/providers/gemini';

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    adapter = new OpenAIAdapter();
    vi.clearAllMocks();
  });

  it('has name "openai"', () => {
    expect(adapter.name).toBe('openai');
  });

  it('estimates tokens (~4 chars per token)', () => {
    const result = adapter.estimateTokens('Hello world test'); // 16 chars
    expect(result.prompt).toBeGreaterThan(0);
    expect(result.prompt).toBe(Math.ceil(16 / 4));
  });

  it('calls OpenAI API with correct format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Response text' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    });

    const result = await adapter.call({
      model: 'gpt-4',
      prompt: 'Hello',
      temperature: 0.7,
      maxTokens: 1000,
    });

    expect(result.output).toBe('Response text');
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(20);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.usd).toBe('number');

    // Verify fetch was called with correct endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer sk-test-openai',
        }),
      })
    );
  });

  it('includes seed when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    });

    await adapter.call({
      model: 'gpt-4',
      prompt: 'Hello',
      temperature: 0.7,
      seed: 42,
    });

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.seed).toBe(42);
  });
});

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    adapter = new AnthropicAdapter();
    vi.clearAllMocks();
  });

  it('has name "anthropic"', () => {
    expect(adapter.name).toBe('anthropic');
  });

  it('estimates tokens (~4 chars per token)', () => {
    const result = adapter.estimateTokens('Test input string'); // 17 chars
    expect(result.prompt).toBeGreaterThan(0);
  });

  it('calls Anthropic API with correct format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: 'Anthropic response' }],
        usage: { input_tokens: 15, output_tokens: 25 },
      }),
    });

    const result = await adapter.call({
      model: 'claude-3-5-sonnet',
      prompt: 'Hello',
      temperature: 0.7,
      maxTokens: 1000,
    });

    expect(result.output).toBe('Anthropic response');
    expect(result.promptTokens).toBe(15);
    expect(result.completionTokens).toBe(25);

    // Verify Anthropic API endpoint and headers
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-test-anthropic',
          'anthropic-version': '2023-06-01',
        }),
      })
    );
  });
});

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
    vi.clearAllMocks();
  });

  it('has name "gemini"', () => {
    expect(adapter.name).toBe('gemini');
  });

  it('estimates tokens (~4 chars per token)', () => {
    const result = adapter.estimateTokens('Gemini test'); // 11 chars
    expect(result.prompt).toBeGreaterThan(0);
  });

  it('calls Gemini API with correct format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'Gemini response' }],
          },
        }],
      }),
    });

    const result = await adapter.call({
      model: 'gemini-1.5-pro',
      prompt: 'Hello',
      temperature: 0.7,
      maxTokens: 1000,
    });

    expect(result.output).toBe('Gemini response');
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.completionTokens).toBeGreaterThan(0);

    // Verify Gemini API endpoint includes API key and model
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.objectContaining({ method: 'POST' })
    );
  });
});
