import { BaseProviderAdapter, normalizeContent, normalizeToolArguments } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, withCause, DEFAULT_CALL_TIMEOUT_MS, retryAfterMsFrom } from './retry.js';
import { store } from '../store.js';

export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;    // USD per token as string
    completion: string; // USD per token as string
  };
}

export class OpenRouterAdapter extends BaseProviderAdapter {
  name: Provider = 'openrouter';

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

      // Build message content — text-only or multimodal with images
      let messageContent: any;
      if (opts.images && opts.images.length > 0) {
        const parts: any[] = opts.images.map(img => ({
          type: 'image_url',
          image_url: {
            url: `data:${img.mimeType};base64,${img.base64}`,
            detail: img.detail ?? 'auto',
          },
        }));
        parts.push({ type: 'text', text: opts.prompt });
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
        temperature: opts.temperature,
        max_tokens: opts.maxTokens ?? 4096,
      };

      if (opts.seed !== undefined) {
        body.seed = opts.seed;
      }

      // Translate providerOptions for OpenRouter's API format.
      //
      // Object.assign wrote passthrough keys OVER the engine's, directly under
      // a comment claiming the opposite ordering: a global `temperature`
      // silently disabled the param operator's temperature evolution here, and
      // a stray `model` billed the call against a different model's price.
      // Assign only the keys the engine does not own.
      if (opts.providerOptions) {
        const { reasoning_effort, ...rest } = opts.providerOptions;
        if (reasoning_effort) {
          body.reasoning = { effort: reasoning_effort };
        }
        for (const [key, value] of Object.entries(rest)) {
          // hasOwnProperty, not `in`: `in` walks the prototype chain, so a
          // passthrough named toString/constructor/valueOf was silently dropped.
          if (!Object.prototype.hasOwnProperty.call(body, key)) body[key] = value;
        }
      }

      console.log(`[OpenRouter] Calling model: ${opts.model}, temperature: ${body.temperature}${body.reasoning ? `, reasoning: ${JSON.stringify(body.reasoning)}` : ''}`);

      if (opts.tools?.length) {
        body.tools = opts.tools.map(t => ({ type: 'function', function: t }));
        body.tool_choice = 'auto';
      }

      let response;
      try {
        response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/lineage-ai',
            'X-Title': 'Lineage',
          },
          body: JSON.stringify(body),
        }, timeoutMs);
      } catch (fetchError: any) {
        // Timeouts must stay retryable — never wrap RetryableError into a plain Error
        if (fetchError instanceof RetryableError) throw fetchError;
        console.error(`[OpenRouter] Fetch failed:`, fetchError.message);
        // Preserve `cause` so isRetryableError can find undici's network code.
        throw withCause(new Error(`OpenRouter fetch failed: ${fetchError.message}`), fetchError);
      }

      if (!response.ok) {
        const error = await response.text();
        console.error(`[OpenRouter] API error ${response.status}:`, error);
        if (response.status === 429 || response.status >= 500) {
          // Carry Retry-After so withRetry waits the window the provider
          // asked for instead of hammering inside it.
          const retryable: any = new RetryableError(`OpenRouter API error: ${response.status} - ${error}`, response.status);
          retryable.retryAfterMs = retryAfterMsFrom(response as any);
          throw retryable;
        }
        throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const latencyMs = Date.now() - startTime;

      // A 200 carrying an error body (or no choices) is a provider failure, not
      // an empty completion — surface it as retryable instead of billing $0 and
      // grading the candidate on an empty string.
      if (data.error) {
        throw new RetryableError(`OpenRouter API returned an error body: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.code ?? 500);
      }
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new RetryableError('OpenRouter response contained no choices', 500);
      }

      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => ({
          name: tc.function?.name ?? '',
          arguments: normalizeToolArguments(tc.function?.arguments, 'OpenRouter'),
        }));
      }

      return {
        output: normalizeContent(message?.content),
        ...(toolCalls ? { toolCalls } : {}),
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
        // The cap ended the reply, not the model. Without this a cut-off
        // answer is graded as a bad one.
        truncated: data.choices?.[0]?.finish_reason === 'length',
      };
    }, {
      maxRetries: 3,
      initialDelayMs: 1000,
    });
  }

  protected async getApiKey(): Promise<string | null> {
    return store.get(`apiKey.${this.name}`) as string | null;
  }

  /**
   * Fetch available models from OpenRouter API.
   * Returns parsed model list with pricing converted to per-1k-token format.
   */
  static async fetchModels(apiKey?: string): Promise<Array<{
    id: string;
    name: string;
    promptUSDper1k: number;
    completionUSDper1k: number;
  }>> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', { headers }, 60_000);

    if (!response.ok) {
      throw new Error(`OpenRouter models fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const models: OpenRouterModel[] = data.data ?? [];

    return models
      .filter(m => m.pricing?.prompt && m.pricing?.completion)
      .map(m => ({
        id: m.id,
        name: m.name,
        promptUSDper1k: parseFloat(m.pricing.prompt) * 1000,
        completionUSDper1k: parseFloat(m.pricing.completion) * 1000,
      }))
      // OpenRouter publishes "-1" as a sentinel for "price varies" on its
      // router models (openrouter/auto and friends). Syncing that verbatim
      // stored -1000 USD per 1k tokens, which made every call earn NEGATIVE
      // cost: fitness exploded, the worst prompt won every selection, and
      // totals.usd ran away from budgetUSD so the cap could never trip.
      .filter(m =>
        Number.isFinite(m.promptUSDper1k) && m.promptUSDper1k >= 0 &&
        Number.isFinite(m.completionUSDper1k) && m.completionUSDper1k >= 0,
      );
  }
}
