import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'test-key-1234', set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/engine/semaphore.js', () => ({
  withGlobalSemaphore: (fn: any) => fn(),
  initGlobalSemaphore: vi.fn(),
  updateGlobalSemaphoreLimit: vi.fn(),
}));
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: async () => ({ provider: 'openai', model: 'm', promptUSDper1k: 0, completionUSDper1k: 0 }),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const TOOLS = [{ name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];

let lastBody: any;
function stub(response: any) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify(response), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastBody = undefined; });

const CALL = { model: 'm', prompt: 'Weather in Paris?', temperature: 0, maxTokens: 50, tools: TOOLS };

describe('openai family', () => {
  const toolResponse = {
    choices: [{ message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  it('translates tools and parses tool_calls (arguments JSON string)', async () => {
    stub(toolResponse);
    const r = await new OpenAIAdapter().call(CALL);
    expect(lastBody.tools).toEqual([{ type: 'function', function: TOOLS[0] }]);
    expect(lastBody.tool_choice).toBe('auto');
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(r.output).toBe(''); // null content normalizes to ''
  });

  it('groq + openrouter share the translation', async () => {
    stub(toolResponse);
    const g = await new GroqAdapter().call(CALL);
    expect(lastBody.tools[0].function.name).toBe('get_weather');
    expect(g.toolCalls?.[0].name).toBe('get_weather');
    stub(toolResponse);
    const o = await new OpenRouterAdapter().call(CALL);
    expect(lastBody.tools[0].function.name).toBe('get_weather');
    expect(o.toolCalls?.[0].arguments).toEqual({ city: 'Paris' });
  });

  it('no tools in opts => no tools in body; no calls => toolCalls absent', async () => {
    stub({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const r = await new OpenAIAdapter().call({ ...CALL, tools: undefined });
    expect(lastBody.tools).toBeUndefined();
    expect(r.toolCalls).toBeUndefined();
    expect(r.output).toBe('hi');
  });

  it('unparseable arguments degrade to {}', async () => {
    stub({ choices: [{ message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: 'NOT JSON' } },
    ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const r = await new OpenAIAdapter().call(CALL);
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: {} }]);
  });
});

describe('gemini', () => {
  it('translates to functionDeclarations and parses functionCall parts (mixed with text)', async () => {
    stub({ candidates: [{ content: { parts: [
      { text: 'Looking that up. ' },
      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
    ] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const r = await new GeminiAdapter().call(CALL);
    expect(lastBody.tools).toEqual([{ functionDeclarations: [{ name: 'get_weather', description: 'Weather lookup', parameters: TOOLS[0].parameters }] }]);
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(r.output).toBe('Looking that up. ');
  });

  it('plain text response keeps working (no toolCalls key)', async () => {
    stub({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const r = await new GeminiAdapter().call({ ...CALL, tools: undefined });
    expect(lastBody.tools).toBeUndefined();
    expect(r.output).toBe('hello');
    expect(r.toolCalls).toBeUndefined();
  });

  it('functionCall-only response (no text parts) yields empty output + toolCalls + nonzero completion tokens', async () => {
    stub({ candidates: [{ content: { parts: [
      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
    ] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const r = await new GeminiAdapter().call(CALL);
    expect(r.output).toBe('');
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(r.completionTokens).toBeGreaterThan(0); // calls count as completion output
  });

  it('strips $schema and additionalProperties from tool parameters (Gemini rejects them)', async () => {
    stub({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await new GeminiAdapter().call({ ...CALL, tools: [{
      name: 'f',
      parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
        properties: { a: { type: 'string' } } } as object,
    }] });
    const params = lastBody.tools[0].functionDeclarations[0].parameters;
    expect(params.$schema).toBeUndefined();
    expect(params.additionalProperties).toBeUndefined();
    expect(params.properties.a).toEqual({ type: 'string' });
  });
});

describe('anthropic', () => {
  it('translates to input_schema tools and parses tool_use blocks', async () => {
    stub({ content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Paris' } },
    ], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await new AnthropicAdapter().call(CALL);
    expect(lastBody.tools).toEqual([{ name: 'get_weather', description: 'Weather lookup', input_schema: TOOLS[0].parameters }]);
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(r.output).toBe('On it.');
  });

  it('tools without parameters get the { type: "object" } input_schema fallback', async () => {
    stub({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await new AnthropicAdapter().call({ ...CALL, tools: [{ name: 'noop' }] });
    expect(lastBody.tools).toEqual([{ name: 'noop', description: undefined, input_schema: { type: 'object' } }]);
  });

  it('type-less text blocks still contribute to output (legacy shape tolerance)', async () => {
    stub({ content: [{ text: 'legacy block' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await new AnthropicAdapter().call({ ...CALL, tools: undefined });
    expect(r.output).toBe('legacy block');
    expect(r.toolCalls).toBeUndefined();
  });
});
