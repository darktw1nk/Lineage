import { BaseProviderAdapter } from './base.js';
import type { Provider } from '../types.js';
import { withRetry, RetryableError } from './retry.js';
import { store } from '../store.js';

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
    providerOptions?: Record<string, any>;
    images?: Array<{ base64: string; mimeType: string; detail?: 'auto' | 'low' | 'high' }>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    return withRetry(async () => {
      const startTime = Date.now();
      
      // Use max_completion_tokens for newer models (o1, gpt-4, gpt-5 series)
      const useCompletionTokens = opts.model.includes('o1') || 
                                   opts.model.includes('gpt-4') || 
                                   opts.model.includes('gpt-5');
      
      // o1 and gpt-5 models have strict temperature requirements
      const hasTemperatureRestrictions = opts.model.includes('o1') || opts.model.includes('gpt-5');
      
      // Build message content — text-only or multimodal with images
      let messageContent: any;
      if (opts.images && opts.images.length > 0) {
        const parts: any[] = [{ type: 'text', text: opts.prompt }];
        for (const img of opts.images) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
              detail: img.detail ?? 'auto',
            },
          });
        }
        messageContent = parts;
      } else {
        messageContent = opts.prompt;
      }

      const body: any = {
        model: opts.model,
        messages: [{ role: 'user', content: messageContent }],
      };
      
      // Handle temperature/seed based on model capabilities
      if (hasTemperatureRestrictions) {
        // These models only support temperature = 1 (default)
        body.temperature = 1;
        console.log(`[OpenAI] Calling model: ${opts.model}, temperature: ${body.temperature} (overridden from ${opts.temperature}), API key: ***${opts.apiKey.slice(-4)}`);
        // Don't include seed for restricted models
      } else {
        body.temperature = opts.temperature;
        body.seed = opts.seed;
        console.log(`[OpenAI] Calling model: ${opts.model}, temperature: ${body.temperature}, API key: ***${opts.apiKey.slice(-4)}`);
      }
      
      if (useCompletionTokens) {
        body.max_completion_tokens = opts.maxTokens ?? 4096;
      } else {
        body.max_tokens = opts.maxTokens ?? 4096;
      }
      
      console.log(`[OpenAI] REQUEST:`, JSON.stringify(body, null, 2));
      
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (fetchError: any) {
        console.error(`[OpenAI] Fetch failed:`, fetchError);
        console.error(`[OpenAI] Error details:`, {
          message: fetchError.message,
          cause: fetchError.cause,
          code: fetchError.code,
          errno: fetchError.errno,
          syscall: fetchError.syscall,
        });
        throw new Error(`OpenAI fetch failed: ${fetchError.message} (cause: ${fetchError.cause?.message || 'unknown'})`);
      }
      
      console.log(`[OpenAI] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`[OpenAI] API error ${response.status}:`, error);
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(`OpenAI API error: ${response.status} - ${error}`, response.status);
        }
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      console.log(`[OpenAI] RESPONSE:`, JSON.stringify(data, null, 2));
      
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
    const key = store.get(`apiKey.${this.name}`) as string | null;
    console.log(`[OpenAI] API key for ${this.name}: ${key ? 'found' : 'NOT FOUND'}`);
    return key;
  }
}

