import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: (k: string) => (k.startsWith('apiKey.') ? 'test-key' : null), set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: vi.fn(async () => ({ promptUSDper1k: 0.001, completionUSDper1k: 0.002 })),
}));

import { isRetryableError, withCause } from '../../src/providers/retry.js';
import { normalizeContent, normalizeToolArguments } from '../../src/providers/base.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

beforeEach(() => initGlobalSemaphore(4));

describe('isRetryableError: undici network failures', () => {
  // Node's fetch throws `TypeError: fetch failed` and hangs the real code off
  // `cause`. Checking only error.code meant NO transient network failure was
  // ever retried — one reset socket discarded a whole candidate's paid results.
  const undiciError = (code: string) => {
    const err: any = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('socket hang up'), { code });
    return err;
  };

  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    it(`retries an undici ${code}`, () => {
      expect(isRetryableError(undiciError(code))).toBe(true);
    });
  }

  it('still retries the bare { code } shape', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('sees through an adapter re-wrap, because withCause preserves the chain', () => {
    const wrapped = withCause(new Error('OpenAI fetch failed: fetch failed'), undiciError('ECONNRESET'));
    expect(isRetryableError(wrapped)).toBe(true);
  });

  it('does not retry a genuine 400', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
  });
});

describe('normalizeContent', () => {
  it('passes a string through', () => {
    expect(normalizeContent('hello')).toBe('hello');
  });

  it('flattens an OpenAI-compatible content-part array', () => {
    // Declared type is string; proxies really do return this shape, and it made
    // scoreJsonSchema throw on raw.trim and put [object Object] in the judge
    // transcript.
    expect(normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('maps null/undefined to an empty string, never "undefined"', () => {
    expect(normalizeContent(null)).toBe('');
    expect(normalizeContent(undefined)).toBe('');
  });
});

describe('normalizeToolArguments', () => {
  it('parses the OpenAI JSON-string form', () => {
    expect(normalizeToolArguments('{"city":"Paris"}', 'T')).toEqual({ city: 'Paris' });
  });

  it('accepts an already-parsed object (bug-hunt regression)', () => {
    // JSON.parse on an object yielded JSON.parse("[object Object]") -> throw ->
    // swallowed -> {}. An identical semantic response scored 6 instead of 10,
    // and the toolCalls shape was not uniform across providers.
    expect(normalizeToolArguments({ city: 'Paris' }, 'T')).toEqual({ city: 'Paris' });
  });

  it('falls back to {} on garbage without throwing', () => {
    expect(normalizeToolArguments('not json', 'T')).toEqual({});
    expect(normalizeToolArguments(undefined, 'T')).toEqual({});
  });
});

function stubFetch(payload: unknown, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('adapters reject a 200 that carries a failure', () => {
  const call = (a: any) => a.call({ model: 'm', prompt: 'p', temperature: 0.5, maxTokens: 100 });

  it('anthropic rejects an empty content array instead of billing $0 for ""', async () => {
    // Anthropic was the only adapter missing this guard: an outage was graded
    // as a bad prompt and killed the lineage.
    stubFetch({ content: [], usage: { input_tokens: 10, output_tokens: 0 } });
    await expect(call(new AnthropicAdapter())).rejects.toThrow(/no content blocks/);
  });

  it('anthropic rejects a 200 error body', async () => {
    stubFetch({ error: { message: 'overloaded' } });
    await expect(call(new AnthropicAdapter())).rejects.toThrow(/overloaded/);
  });

  it('openai still rejects a 200 error body', async () => {
    stubFetch({ error: { message: 'upstream boom' } });
    await expect(call(new OpenAIAdapter())).rejects.toThrow(/upstream boom/);
  });
});

describe('OpenAI reasoning-model parameter selection', () => {
  const bodyFor = async (model: string) => {
    const fn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fn);
    await new OpenAIAdapter().call({ model, prompt: 'p', temperature: 0.2, maxTokens: 100 });
    return JSON.parse((fn.mock.calls[0][1] as any).body);
  };

  // Matching only the literal 'o1' missed o3/o4 entirely: they were sent
  // max_tokens plus a real temperature and got an immediate 400 that is not
  // retryable, so every o3/o4 node failed.
  for (const model of ['o1', 'o3', 'o3-mini', 'o4-mini']) {
    it(`${model} gets max_completion_tokens and temperature 1`, async () => {
      const body = await bodyFor(model);
      expect(body.max_completion_tokens).toBeDefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBe(1);
    });
  }

  it('gpt-4o is NOT mistaken for a reasoning model', async () => {
    const body = await bodyFor('gpt-4o');
    expect(body.temperature).toBe(0.2); // the caller's value survives
  });
});

describe('OpenRouter model sync rejects impossible prices', () => {
  it('drops the "-1" price-varies sentinel', async () => {
    // Stored verbatim this became -1000 USD per 1k tokens: every call earned
    // NEGATIVE cost, fitness exploded, and totals.usd ran away from budgetUSD
    // so the cap could never trip.
    stubFetch({
      data: [
        { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'real/model', name: 'Real', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'free/model', name: 'Free', pricing: { prompt: '0', completion: '0' } },
      ],
    });
    const models = await OpenRouterAdapter.fetchModels();
    expect(models.map(m => m.id)).toEqual(['real/model', 'free/model']); // $0 is legitimate, -1 is not
    expect(models.every(m => m.promptUSDper1k >= 0 && m.completionUSDper1k >= 0)).toBe(true);
  });
});
