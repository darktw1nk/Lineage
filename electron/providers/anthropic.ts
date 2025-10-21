import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../../src/types/index.js';
import { withRetry, RetryableError } from './retry.js';
import { store } from '../store.js';

export class AnthropicAdapter extends BaseProviderAdapter {
  name: Provider = 'anthropic';
  
  estimateTokens(input: string): { prompt: number; completion?: number } {
    // Rough approximation: ~4 chars per token
    const prompt = Math.ceil(input.length / 4);
    return { prompt };
  }
  
  async callAPI(opts: {
    apiKey: string;
    model: string;
    prompt: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    return withRetry(async () => {
      const startTime = Date.now();
      
      console.log(`[Anthropic] Calling model: ${opts.model}, temperature: ${opts.temperature}, API key: ***${opts.apiKey.slice(-4)}`);
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: opts.prompt }],
          temperature: opts.temperature,
          max_tokens: opts.maxTokens ?? 4096,
        }),
      });
      
      if (!response.ok) {
        const error = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`Anthropic API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`Anthropic API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      const latencyMs = Date.now() - startTime;
      
      return {
        output: data.content?.[0]?.text ?? '',
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        latencyMs,
      };
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
    });
  }
  
  protected async getApiKey(): Promise<string | null> {
    return store.get(`apiKey.${this.name}`) as string | null;
  }
}

