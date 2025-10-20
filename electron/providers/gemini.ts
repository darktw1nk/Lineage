import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../../src/types/index.js';
import * as keytar from 'keytar';
import { withRetry, RetryableError } from './retry.js';

const SERVICE_NAME = 'PromptEvolution';

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
      
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: opts.prompt }] }],
            generationConfig: {
              temperature: opts.temperature,
              maxOutputTokens: opts.maxTokens ?? 4096,
            },
          }),
        }
      );
      
      if (!response.ok) {
        const error = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`Gemini API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`Gemini API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      const latencyMs = Date.now() - startTime;
      
      // Gemini token counting is approximate
      const output = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const promptTokens = this.estimateTokens(opts.prompt).prompt;
      const completionTokens = this.estimateTokens(output).prompt;
      
      return {
        output,
        promptTokens,
        completionTokens,
        latencyMs,
      };
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
    });
  }
  
  protected async getApiKey(): Promise<string | null> {
    return await keytar.getPassword(SERVICE_NAME, 'gemini');
  }
}

