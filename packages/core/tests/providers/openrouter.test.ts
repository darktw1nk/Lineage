import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store before importing adapter
vi.mock('../../src/store.js', () => ({
  store: {
    get: vi.fn().mockReturnValue('test-openrouter-key'),
    set: vi.fn(),
    delete: vi.fn(),
    store: {},
  },
}));

// Mock semaphore
vi.mock('../../src/engine/semaphore.js', () => ({
  withGlobalSemaphore: vi.fn().mockImplementation((fn) => fn()),
}));

// Mock costs
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: vi.fn().mockResolvedValue({
    promptUSDper1k: 0.003,
    completionUSDper1k: 0.015,
  }),
}));

import { OpenRouterAdapter } from '../../src/providers/openrouter';

describe('OpenRouterAdapter', () => {
  let adapter: OpenRouterAdapter;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new OpenRouterAdapter();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('has correct provider name', () => {
    expect(adapter.name).toBe('openrouter');
  });

  it('estimates tokens at ~4 chars per token', () => {
    const result = adapter.estimateTokens('Hello world!');
    expect(result.prompt).toBe(3); // ceil(12/4)
  });

  describe('callAPI', () => {
    it('sends correct request format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      });

      const result = await adapter.callAPI({
        apiKey: 'sk-test-key',
        model: 'openai/gpt-4o',
        prompt: 'Hello',
        temperature: 0.7,
        maxTokens: 2048,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer sk-test-key',
            'Content-Type': 'application/json',
            'HTTP-Referer': expect.any(String),
            'X-Title': 'Lineage',
          }),
        }),
      );

      // Verify body
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('openai/gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(2048);

      expect(result.output).toBe('response text');
      expect(result.promptTokens).toBe(10);
      expect(result.completionTokens).toBe(20);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('includes seed when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      });

      await adapter.callAPI({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.5,
        seed: 42,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.seed).toBe(42);
    });

    it('defaults max_tokens to 4096', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      });

      await adapter.callAPI({
        apiKey: 'sk-test',
        model: 'anthropic/claude-3.5-sonnet',
        prompt: 'test',
        temperature: 0.7,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(4096);
    });

    it('throws RetryableError on 429', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      await expect(adapter.callAPI({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.7,
      })).rejects.toThrow('OpenRouter API error: 429');
    });

    it('throws RetryableError on 500+', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      });

      await expect(adapter.callAPI({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.7,
      })).rejects.toThrow('OpenRouter API error: 502');
    });

    it('throws plain Error on 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(adapter.callAPI({
        apiKey: 'bad-key',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.7,
      })).rejects.toThrow('OpenRouter API error: 401');
    });

    it('handles missing content gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: {} }],
          usage: {},
        }),
      });

      const result = await adapter.callAPI({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.7,
      });

      expect(result.output).toBe('');
      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
    });

    it('handles fetch network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network failure'));

      await expect(adapter.callAPI({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        prompt: 'test',
        temperature: 0.7,
      })).rejects.toThrow('OpenRouter fetch failed: Network failure');
    });
  });

  describe('fetchModels', () => {
    it('parses model list and converts pricing to per-1k', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'openai/gpt-4o',
              name: 'GPT-4o',
              pricing: { prompt: '0.0000025', completion: '0.00001' },
            },
            {
              id: 'anthropic/claude-3.5-sonnet',
              name: 'Claude 3.5 Sonnet',
              pricing: { prompt: '0.000003', completion: '0.000015' },
            },
          ],
        }),
      });

      const models = await OpenRouterAdapter.fetchModels('sk-key');

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('openai/gpt-4o');
      expect(models[0].name).toBe('GPT-4o');
      // 0.0000025 per token * 1000 = 0.0025 per 1k tokens
      expect(models[0].promptUSDper1k).toBeCloseTo(0.0025);
      // 0.00001 per token * 1000 = 0.01 per 1k tokens
      expect(models[0].completionUSDper1k).toBeCloseTo(0.01);

      expect(models[1].id).toBe('anthropic/claude-3.5-sonnet');
      expect(models[1].promptUSDper1k).toBeCloseTo(0.003);
      expect(models[1].completionUSDper1k).toBeCloseTo(0.015);
    });

    it('sends auth header when apiKey provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await OpenRouterAdapter.fetchModels('sk-my-key');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer sk-my-key' },
        }),
      );
    });

    it('sends no auth header when apiKey omitted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await OpenRouterAdapter.fetchModels();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it('filters out models with missing pricing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'good/model', name: 'Good', pricing: { prompt: '0.001', completion: '0.002' } },
            { id: 'no-pricing/model', name: 'No Pricing' },
            { id: 'partial/model', name: 'Partial', pricing: { prompt: '0.001' } },
          ],
        }),
      });

      const models = await OpenRouterAdapter.fetchModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('good/model');
    });

    it('filters out models with NaN pricing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'bad/model', name: 'Bad', pricing: { prompt: 'free', completion: 'free' } },
            { id: 'good/model', name: 'Good', pricing: { prompt: '0.001', completion: '0.002' } },
          ],
        }),
      });

      const models = await OpenRouterAdapter.fetchModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('good/model');
    });

    it('handles empty data array', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const models = await OpenRouterAdapter.fetchModels();
      expect(models).toEqual([]);
    });

    it('handles missing data field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const models = await OpenRouterAdapter.fetchModels();
      expect(models).toEqual([]);
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(OpenRouterAdapter.fetchModels()).rejects.toThrow('OpenRouter models fetch failed: 500');
    });
  });
});

describe('OpenRouter in provider factory', () => {
  it('factory returns OpenRouterAdapter for openrouter', async () => {
    // Import dynamically to avoid store/semaphore mock conflicts
    const { getProviderAdapter } = await import('../../src/providers/index');
    const adapter = getProviderAdapter('openrouter');
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe('openrouter');
  });
});
