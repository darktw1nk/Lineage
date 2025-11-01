import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../../src/types/index.js';
import { withRetry, RetryableError } from './retry.js';
import { store } from '../store.js';

export class GeminiAdapter extends BaseProviderAdapter {
  name: Provider = 'gemini';
  
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
      console.log("apikey: "+opts.apiKey);
      console.log(`[Gemini] Calling model: ${opts.model}, temperature: ${opts.temperature}, API key: ***${opts.apiKey.slice(-4)}`);
      
      const body = {
        contents: [{ parts: [{ text: opts.prompt }] }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens ?? 4096,
        },
      };
      
      console.log(`[Gemini] REQUEST:`, JSON.stringify(body, null, 2));
      
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': opts.apiKey,
          },
          body: JSON.stringify(body),
        }
      );
      
      console.log(`[Gemini] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const error = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`Gemini API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`Gemini API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      console.log(`[Gemini] RESPONSE:`, JSON.stringify(data, null, 2));
      
      const latencyMs = Date.now() - startTime;
      
      // Gemini token counting is approximate
      const output = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const promptTokens = this.estimateTokens(opts.prompt).prompt;
      const completionTokens = this.estimateTokens(output).prompt;
      
      const result = {
        output,
        promptTokens,
        completionTokens,
        latencyMs,
      };
      
      console.log(`[Gemini] Parsed result - output length: ${result.output.length}, tokens: ${result.promptTokens}/${result.completionTokens}, latency: ${result.latencyMs}ms`);
      
      return result;
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
    });
  }
  
  protected async getApiKey(): Promise<string | null> {
    return store.get(`apiKey.${this.name}`) as string | null;
  }
}

