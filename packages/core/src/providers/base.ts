import type { Provider, ProviderAdapter, ToolDef } from '../types.js';
import { getModelCost } from './costs.js';
import { withGlobalSemaphore } from '../engine/semaphore.js';
import { withCause } from './retry.js';

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract name: Provider;
  
  abstract estimateTokens(input: string): { prompt: number; completion?: number };
  
  abstract callAPI(opts: {
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
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;

  async call(opts: {
    model: string;
    prompt: string;
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
    usd: number;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }> {
    // Wrap ALL API calls with global semaphore
    return withGlobalSemaphore(async () => {
      // Get API key from environment or keytar
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        throw new Error(`No API key found for provider: ${this.name}`);
      }
      
      const startTime = Date.now();
      
      try {
        const result = await this.callAPI({
          apiKey,
          ...opts,
        });
        
        const latencyMs = Date.now() - startTime;
        
        // Price lookup is a LOCAL database read. Letting it throw here threw
        // away a completion that was already made and already billed by the
        // provider — the money was spent, the result discarded, and the node
        // marked failed. Fall back to unpriced instead.
        let cost: Awaited<ReturnType<typeof getModelCost>> = null;
        try {
          cost = await getModelCost({ provider: this.name, model: opts.model });
        } catch (costError) {
          console.error(
            `[BaseAdapter] Price lookup failed for ${this.name}/${opts.model} — recording this call as $0:`,
            costError,
          );
        }

        console.log(`[BaseAdapter] Cost entry for ${this.name}/${opts.model}:`, cost);
        
        // Last line of defence on price data: a negative or non-finite entry
        // (an OpenRouter "-1" sentinel, a hand-typed price in Settings, a
        // plugin's catalog) must never produce negative or NaN spend. Negative
        // spend inverts fitness and disarms the budget cap; NaN disables the
        // cap silently, because NaN >= limit is always false.
        const rawUsd = cost
          ? (result.promptTokens / 1000) * cost.promptUSDper1k +
            (result.completionTokens / 1000) * cost.completionUSDper1k
          : 0;
        const usd = Number.isFinite(rawUsd) ? Math.max(0, rawUsd) : 0;
        if (rawUsd !== usd) {
          console.error(
            `[BaseAdapter] ${this.name}/${opts.model} produced an impossible cost (${rawUsd}) from ` +
            `prompt=${cost?.promptUSDper1k} completion=${cost?.completionUSDper1k} per 1k — treating it as $0. ` +
            `Fix the model's pricing; budget enforcement cannot be trusted for this model.`,
          );
        }
        
        console.log(`[BaseAdapter] Calculated USD: ${usd} (prompt: ${result.promptTokens}, completion: ${result.completionTokens})`);
        
        return {
          ...result,
          latencyMs,
          usd,
        };
      } catch (error: any) {
        // Preserve the original as `cause` and carry `status` forward. String
        // interpolation erased both, so callers lost the HTTP status and
        // isRetryableError could no longer see undici's network code.
        const wrapped: any = withCause(
          new Error(`Provider ${this.name} call failed: ${error?.message ?? error}`),
          error,
        );
        if (error?.status !== undefined) wrapped.status = error.status;
        if (error?.statusCode !== undefined) wrapped.statusCode = error.statusCode;
        throw wrapped;
      }
    }, `${this.name}/${opts.model}`);
  }
  
  protected abstract getApiKey(): Promise<string | null>;
}


/**
 * Normalise a chat-completions `message.content` to a string.
 *
 * The adapter contract declares `output: string`, but OpenAI-compatible
 * proxies legitimately return `content: [{type:'text',text:'…'}]`. Passing
 * that through unchanged made `scoreJsonSchema` throw on `raw.trim`, and put
 * a literal "[object Object]" into the judge transcript.
 */
export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return typeof (content as any).text === 'string' ? (content as any).text : '';
}

/**
 * Normalise tool-call arguments to an object.
 *
 * OpenAI sends them as a JSON *string*; some compatible providers send an
 * object already. Blindly JSON.parse-ing meant an object became
 * `JSON.parse("[object Object]")` → SyntaxError → swallowed → `{}`, so an
 * identical semantic response scored 6 instead of 10. Anthropic and Gemini
 * always send objects, so without this the `toolCalls` shape was not uniform
 * across providers — and `scoreToolCall` depends on it being uniform.
 */
export function normalizeToolArguments(raw: unknown, providerLabel: string): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.warn(`[${providerLabel}] Unparseable tool arguments:`, raw);
    return {};
  }
}

/**
 * Compact a request/response body for logging.
 *
 * These were logged in full at every call. A test image is a multi-megabyte
 * base64 string, so one vision run flooded the CLI's stderr and the desktop's
 * 1000-entry log buffer (which is broadcast to the renderer) — and duplicated
 * the file's contents into the log stream. Long strings are elided; nothing
 * else about the shape changes.
 */
export function logSafeBody(value: unknown, maxStringLength = 500): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === 'string' && val.length > maxStringLength) {
      return `${val.slice(0, maxStringLength)}…[${val.length - maxStringLength} more chars]`;
    }
    if (val && typeof val === 'object') {
      if (seen.has(val as object)) return '[circular]';
      seen.add(val as object);
    }
    return val;
  };
  try {
    return JSON.stringify(value, replacer, 2) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}
