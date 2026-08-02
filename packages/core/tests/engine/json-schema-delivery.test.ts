import { describe, it, expect, vi } from 'vitest';

/**
 * Driven through `callAPI`, the layer that builds the request body and takes
 * `apiKey` explicitly. `call()` resolves the key from the platform store, which
 * a unit test should not have to populate.
 *
 * `json_schema` mode must SHOW the model the schema it will be graded against.
 *
 * The scorer validates the reply against `test.schema`, but nothing ever sent
 * that schema to the model. `tool_call` mode passes `tools` through to the
 * provider; `json_schema` passed nothing. So a user who supplies a JSON Schema
 * gets output graded against a contract the model was never told about, and
 * can only pass by guessing the exact field names. The benchmark task built on
 * this mode was written off as "a documented bad test" — it was a real gap in
 * the engine wearing a test's clothes.
 *
 * These assert on what reaches the PROVIDER, which is the only place the fix
 * can be observed. A test that only checked scoring would pass either way.
 */
const calls: any[] = [];
vi.mock('../../src/store.js', () => ({ store: { get: () => null, set: () => {}, store: {} }, setStore: vi.fn() }));

const SCHEMA = {
  type: 'object',
  properties: { passenger: { type: 'string' }, flight: { type: 'string' } },
  required: ['passenger', 'flight'],
  additionalProperties: false,
};

describe('the OpenAI adapter asks for schema-conforming output', () => {
  it('sends a json_schema response_format when a schema is supplied', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"passenger":"A","flight":"B"}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    calls.length = 0;

    const { OpenAIAdapter } = await import('../../src/providers/openai.js');
    const adapter: any = new (OpenAIAdapter as any)();
    await adapter.callAPI({
      model: 'gpt-5-nano', prompt: 'Extract the booking.', apiKey: 'sk-test',
      temperature: 0, maxTokens: 256, jsonSchema: SCHEMA,
    });

    expect(calls).toHaveLength(1);
    const body = calls[0];
    expect(body.response_format, 'no response_format on the request').toBeDefined();
    expect(body.response_format.type).toBe('json_schema');
    // The schema itself must travel, not merely a "give me JSON" hint: the
    // scorer checks field names, so a bare json_object mode still fails.
    const sent = JSON.stringify(body.response_format);
    expect(sent).toContain('passenger');
    expect(sent).toContain('flight');
  });

  it('sends no response_format when no schema is supplied', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    calls.length = 0;

    const { OpenAIAdapter } = await import('../../src/providers/openai.js');
    const adapter: any = new (OpenAIAdapter as any)();
    await adapter.callAPI({ model: 'gpt-5-nano', prompt: 'hello', apiKey: 'sk-test', temperature: 0, maxTokens: 64 });
    expect(calls[0].response_format).toBeUndefined();
  });
});

describe('the Gemini adapter asks for schema-conforming output', () => {
  it('sets responseSchema and a JSON mime type when a schema is supplied', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"passenger":"A","flight":"B"}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    calls.length = 0;

    const { GeminiAdapter } = await import('../../src/providers/gemini.js');
    const adapter: any = new (GeminiAdapter as any)();
    await adapter.callAPI({
      model: 'gemini-2.5-flash-lite', prompt: 'Extract the booking.', apiKey: 'k',
      temperature: 0, maxTokens: 256, jsonSchema: SCHEMA,
    });

    const cfg = calls[0].generationConfig;
    expect(cfg, 'no generationConfig on the request').toBeDefined();
    expect(cfg.responseMimeType).toBe('application/json');
    expect(JSON.stringify(cfg.responseSchema)).toContain('passenger');
  });
});

/**
 * WIRING. The adapter tests above pass even if the EVALUATOR never puts a
 * schema on the call — verified by mutation: deleting the evaluator's
 * `jsonSchema` line broke none of the 1,115 core tests. This drives the real
 * evaluation loop with a fake provider and asserts on what the model was
 * handed for a `json_schema` test.
 */
describe('the evaluator hands the schema to the model', () => {
  it('puts the test schema on the candidate call, and only for json_schema tests', async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    const path = await import('node:path');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const { registerProvider, resetRegistry } = await import('../../src/registry.js');
    const { initializeDatabase, closeDatabase, getDatabase } = await import('../../src/database/init.js');
    const { setSendUpdate, startEvaluation } = await import('../../src/engine/evaluator_v2.js');

    resetRegistry();
    const seen: Array<{ prompt: string; jsonSchema?: object }> = [];
    registerProvider({
      adapter: {
        name: 'fake', estimateTokens: () => ({ prompt: 1 }),
        call: async (opts: any) => {
          seen.push({ prompt: opts.prompt, jsonSchema: opts.jsonSchema });
          return { output: '{"passenger":"A","flight":"B"}', promptTokens: 2, completionTokens: 3, latencyMs: 1, usd: 0 };
        },
      } as any,
    });

    const config: any = {
      id: 'js-cfg', name: 'schema wiring',
      selection: { policy: 'topk', topK: 1 },
      operators: { mutationShare: 0, crossoverShare: 0 },
      population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED', fill: 'auto' },
      enabledModels: [{ provider: 'fake', model: 'fake-1' }],
      testSet: [
        { id: 's1', name: 'schema', mode: 'json_schema', prompt: 'BOOKING INPUT', schema: SCHEMA },
        // Carries a leftover `schema` on purpose: a user who switches a test
        // from json_schema to exact_match leaves the field behind, and mode —
        // not the field's presence — must decide whether JSON is forced.
        { id: 'e1', name: 'plain', mode: 'exact_match', prompt: 'PLAIN INPUT', expected: 'x', schema: SCHEMA },
      ],
      fitness: { weights: { quality: 1 } },
      targets: { maxGenerations: 1 },
      serviceModel: { provider: 'fake', model: 'fake-1' },
      parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
    };

    const tmpDb = path.join(os.tmpdir(), `pe-js-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = {
      id: 'r-js-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
      generations: [], cacheHits: 0, version: '1.0',
    };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
    const done = new Promise<void>(res => setSendUpdate((_id, data: any) => {
      if (data.type === 'status' && data.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    await done;
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});

    const schemaCall = seen.find(c => c.prompt === 'BOOKING INPUT');
    expect(schemaCall, 'the json_schema test never reached the model').toBeDefined();
    expect(schemaCall!.jsonSchema, 'schema was not sent with the json_schema test').toEqual(SCHEMA);

    // An exact_match test must NOT be forced into JSON — that would change how
    // every non-schema test is answered.
    const plainCall = seen.find(c => c.prompt === 'PLAIN INPUT');
    expect(plainCall!.jsonSchema).toBeUndefined();
  });
});
