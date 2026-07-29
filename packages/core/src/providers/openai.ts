import { BaseProviderAdapter } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS } from './retry.js';
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
    system?: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
    timeoutMs?: number;
    tools?: ToolDef[];
    providerOptions?: Record<string, any>;
    images?: Array<{ base64: string; mimeType: string; detail?: 'auto' | 'low' | 'high' }>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
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
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: messageContent },
        ],
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
      
      if (opts.tools?.length) {
        body.tools = opts.tools.map(t => ({ type: 'function', function: t }));
        body.tool_choice = 'auto';
      }

      console.log(`[OpenAI] REQUEST:`, JSON.stringify(body, null, 2));

      let response;
      try {
        response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }, timeoutMs);
      } catch (fetchError: any) {
        // Timeouts must stay retryable — never wrap RetryableError into a plain Error
        if (fetchError instanceof RetryableError) throw fetchError;
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
      
      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); }
          catch { console.warn('[OpenAI] Unparseable tool arguments:', tc.function?.arguments); }
          return { name: tc.function?.name ?? '', arguments: args };
        });
      }

      return {
        output: message?.content ?? '',
        ...(toolCalls ? { toolCalls } : {}),
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

