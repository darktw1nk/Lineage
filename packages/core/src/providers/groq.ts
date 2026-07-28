import { BaseProviderAdapter } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS } from './retry.js';
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
    timeoutMs?: number;
    tools?: ToolDef[];
    providerOptions?: Record<string, any>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
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

      if (opts.tools?.length) {
        body.tools = opts.tools.map(t => ({ type: 'function', function: t }));
        body.tool_choice = 'auto';
      }

      let response;
      try {
        response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }, timeoutMs);
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

      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); }
          catch { console.warn('[Groq] Unparseable tool arguments:', tc.function?.arguments); }
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
    return store.get(`apiKey.${this.name}`) as string | null;
  }
}
