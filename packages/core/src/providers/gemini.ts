import { BaseProviderAdapter } from './base.js';
import type { Provider, ToolDef } from '../types.js';
import { withRetry, RetryableError, fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS } from './retry.js';

// Gemini's proto-backed functionDeclarations schema rejects some common JSON
// Schema keywords ($schema, additionalProperties) with a hard 400. Strip them
// recursively so OpenAI-style tool definitions work as-is.
function stripUnsupportedSchemaKeys(schema: any): any {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys);
  if (schema && typeof schema === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === '$schema' || k === 'additionalProperties') continue;
      out[k] = stripUnsupportedSchemaKeys(v);
    }
    return out;
  }
  return schema;
}
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
    system?: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
    timeoutMs?: number;
    tools?: ToolDef[];
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
    return withRetry(async () => {
      const startTime = Date.now();
      console.log(`[Gemini] Calling model: ${opts.model}, temperature: ${opts.temperature}, API key: ***${opts.apiKey.slice(-4)}`);
      
      const body: any = {
        contents: [{ parts: [{ text: opts.prompt }] }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens ?? 4096,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        },
        ...(opts.tools?.length
          ? { tools: [{ functionDeclarations: opts.tools.map(t => ({ name: t.name, description: t.description, parameters: stripUnsupportedSchemaKeys(t.parameters) })) }] }
          : {}),
      };
      if (opts.system) {
        body.systemInstruction = { parts: [{ text: opts.system }] };
      }
      
      console.log(`[Gemini] REQUEST:`, JSON.stringify(body, null, 2));
      
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': opts.apiKey,
          },
          body: JSON.stringify(body),
        },
        timeoutMs
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
      
      // A 200 carrying an error object (or no candidates at all) must not be
      // treated as an empty-but-successful completion — that bills $0 and
      // grades the candidate on "".
      if (data.error) {
        throw new RetryableError(`Gemini API returned an error body: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.code ?? 500);
      }
      if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
        throw new RetryableError(`Gemini response has no candidates (finishReason: ${data.promptFeedback?.blockReason ?? 'unknown'})`, 500);
      }

      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const output = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('');
      const fnParts = parts.filter((p: any) => p.functionCall);
      const toolCalls = fnParts.length > 0
        ? fnParts.map((p: any) => ({ name: p.functionCall.name, arguments: p.functionCall.args ?? {} }))
        : undefined;

      // Prefer the API's own usage numbers. The char-estimate fallback missed
      // opts.system entirely (the candidate prompt — usually the LARGEST input,
      // since promptMode defaults to 'system') and all reasoning tokens, which
      // undercounted real spend by orders of magnitude on 2.5-series models.
      const usage = data.usageMetadata;
      const promptTokens = usage?.promptTokenCount
        ?? this.estimateTokens((opts.system ? opts.system + '\n\n' : '') + opts.prompt).prompt;
      // Function calls ARE completion output; thinking tokens are billed as output too
      const completionText = output + fnParts.map((p: any) => JSON.stringify(p.functionCall)).join('');
      const completionTokens = usage
        ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
        : this.estimateTokens(completionText).prompt;

      const result = {
        output,
        ...(toolCalls ? { toolCalls } : {}),
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

