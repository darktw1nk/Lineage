import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../../src/types/index.js';
import { withRetry, RetryableError } from './retry.js';

export class OpenAIAdapter extends BaseProviderAdapter {
  name: Provider = 'openai';
  
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
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: opts.prompt }],
          temperature: opts.temperature,
          seed: opts.seed,
          max_tokens: opts.maxTokens ?? 4096,
        }),
      });
      
      if (!response.ok) {
        const error = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`OpenAI API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      const latencyMs = Date.now() - startTime;
      
      return {
        output: data.choices[0]?.message?.content ?? '',
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
    });
  }
  
  protected async getApiKey(): Promise<string | null> {
    // API key retrieval is handled by the main process
    // Providers receive keys as parameters
    return null;
  }
}

