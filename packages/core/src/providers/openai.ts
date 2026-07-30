import { BaseProviderAdapter, normalizeContent, normalizeToolArguments, logSafeBody } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, withCause, DEFAULT_CALL_TIMEOUT_MS, retryAfterMsFrom } from './retry.js';
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
      
      // Reasoning models (o-series, codex, gpt-5) require max_completion_tokens
      // and reject any temperature but 1. Matching only the literal 'o1' missed
      // o3/o3-mini/o4-mini entirely, so every o3/o4 call was sent max_tokens
      // with a real temperature and got an immediate, non-retryable 400.
      //
      // Matched against the BASE model name: a fine-tune is named
      // `ft:gpt-4o-…:my-o1-experiment:…`, and matching the whole string made
      // that a false positive. Case-insensitive for Azure-style ids.
      const baseModel = opts.model.split(':')[0].split('/').pop() ?? opts.model;
      const isReasoningModel =
        /(^|[^a-z])o[1-9](-|$|[0-9])/i.test(baseModel) ||
        /(^|[^a-z])codex(-|$)/i.test(baseModel) ||
        /gpt-5/i.test(baseModel);
      const useCompletionTokens = isReasoningModel || opts.model.includes('gpt-4');
      const hasTemperatureRestrictions = isReasoningModel;
      
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

      // Raw passthrough of providerOptions, applied BEFORE the engine's own
      // fields so a stray key cannot rewrite model/messages/tools. README
      // documents this with no provider caveat, but three adapters ignored it
      // — openai even declared it in the signature and never read it. A user
      // sets reasoning_effort: 'high', pays low-effort prices, and concludes
      // the prompt is the problem.
      const body: any = {
        ...(opts.providerOptions || {}),
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

      console.log(`[OpenAI] REQUEST:`, logSafeBody(body));

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
        // Keep the original as `cause`: isRetryableError walks that chain to
        // find undici's ECONNRESET/UND_ERR_SOCKET code. Dropping it made every
        // transient network blip permanently fail the node.
        throw withCause(
          new Error(`OpenAI fetch failed: ${fetchError.message} (cause: ${fetchError.cause?.message || 'unknown'})`),
          fetchError,
        );
      }
      
      console.log(`[OpenAI] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`[OpenAI] API error ${response.status}:`, error);
        if (response.status === 429 || response.status >= 500) {
          // Carry Retry-After so withRetry waits the window the provider
          // asked for instead of hammering inside it.
          const retryable: any = new RetryableError(`OpenAI API error: ${response.status} - ${error}`, response.status);
          retryable.retryAfterMs = retryAfterMsFrom(response as any);
          throw retryable;
        }
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }
      
      const data = await response.json();
      console.log(`[OpenAI] RESPONSE:`, logSafeBody(data));
      
      const latencyMs = Date.now() - startTime;
      
      // A 200 carrying an error body (or no choices) is a provider failure, not
      // an empty completion — surface it as retryable instead of billing $0 and
      // grading the candidate on an empty string.
      if (data.error) {
        throw new RetryableError(`OpenAI API returned an error body: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.code ?? 500);
      }
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new RetryableError('OpenAI response contained no choices', 500);
      }

      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => ({
          name: tc.function?.name ?? '',
          arguments: normalizeToolArguments(tc.function?.arguments, 'OpenAI'),
        }));
      }

      // A content filter is a provider-side failure, not a bad answer.
      if (data.choices?.[0]?.finish_reason === 'content_filter') {
        throw new RetryableError('OpenAI stopped the response with finish_reason "content_filter"', 500);
      }

      return {
        // A refusal carries its text in `message.refusal`, not `content`.
        // Dropping it graded the candidate on an empty string, so a refusal
        // was indistinguishable from a broken call.
        output: normalizeContent(message?.content) || normalizeContent(message?.refusal),
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
    const key = store.get(`apiKey.${this.name}`) as string | null;
    console.log(`[OpenAI] API key for ${this.name}: ${key ? 'found' : 'NOT FOUND'}`);
    return key;
  }
}

