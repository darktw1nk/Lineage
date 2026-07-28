import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../types.js';
import { withRetry, RetryableError } from './retry.js';
import { store } from '../store.js';

export class GroqAdapter extends BaseProviderAdapter {
  name: Provider = 'groq';

  estimateTokens(input: string): { prompt: number; completion?: number } {
    const prompt = Math.ceil(input.length / 4);
    return { prompt };
  }

  async callAPI(opts: {
    apiKey: string;
    model: string;
    prompt: string;
    system?: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
    providerOptions?: Record<string, any>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    return withRetry(async () => {
      const startTime = Date.now();

      const body: any = {
        model: opts.model,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.prompt },
        ],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.providerOptions || {}),
      };

      if (opts.seed !== undefined) {
        body.seed = opts.seed;
      }

      console.log(`[Groq] Calling model: ${opts.model}, temperature: ${body.temperature}${body.reasoning_effort ? `, reasoning_effort: ${body.reasoning_effort}` : ''}`);

      let response;
      try {
        response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (fetchError: any) {
        console.error(`[Groq] Fetch failed:`, fetchError.message);
        throw new Error(`Groq fetch failed: ${fetchError.message}`);
      }

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Groq] API error ${response.status}:`, error);
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`Groq API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`Groq API error: ${response.status} - ${error}`);
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
    return store.get(`apiKey.${this.name}`) as string | null;
  }
}
