import { BaseProviderAdapter, normalizeContent, normalizeToolArguments } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, withCause, DEFAULT_CALL_TIMEOUT_MS, retryAfterMsFrom } from './retry.js';
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
    images?: Array<{ base64: string; mimeType: string; detail?: 'auto' | 'low' | 'high' }>;
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
          // OpenAI-compatible image_url blocks. Groq did not declare or read
          // `images`, so a vision test sent the prompt with no image attached
          // and every candidate was graded on a question it could not see.
          {
            role: 'user',
            content: opts.images?.length
              ? [
                  { type: 'text', text: opts.prompt },
                  ...opts.images.map(img => ({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                  })),
                ]
              : opts.prompt,
          },
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
        // Timeouts must stay retryable — never wrap RetryableError into a plain Error
        if (fetchError instanceof RetryableError) throw fetchError;
        console.error(`[Groq] Fetch failed:`, fetchError.message);
        // Preserve `cause` so isRetryableError can find undici's network code.
        throw withCause(new Error(`Groq fetch failed: ${fetchError.message}`), fetchError);
      }

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Groq] API error ${response.status}:`, error);
        if (response.status === 429 || response.status >= 500) {
          // Carry Retry-After so withRetry waits the window the provider
          // asked for instead of hammering inside it.
          const retryable: any = new RetryableError(`Groq API error: ${response.status} - ${error}`, response.status);
          retryable.retryAfterMs = retryAfterMsFrom(response as any);
          throw retryable;
        }
        throw new Error(`Groq API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const latencyMs = Date.now() - startTime;

      // A 200 carrying an error body (or no choices) is a provider failure, not
      // an empty completion — surface it as retryable instead of billing $0 and
      // grading the candidate on an empty string.
      if (data.error) {
        throw new RetryableError(`Groq API returned an error body: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.code ?? 500);
      }
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new RetryableError('Groq response contained no choices', 500);
      }

      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => ({
          name: tc.function?.name ?? '',
          arguments: normalizeToolArguments(tc.function?.arguments, 'Groq'),
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
}
