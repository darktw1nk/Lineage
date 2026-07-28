# Tool-Call + Structured-Output Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two deterministic test modes — `json_schema` (ajv conformance) and `tool_call` (right function, right arguments) — wired through types, all five provider adapters, the engine, CLI, and desktop UI.

**Architecture:** A new `engine/structured.ts` owns both scorers (pure, judge-free, gradient-shaped). Adapters translate the canonical OpenAI `ToolDef` per provider and normalize responses to `toolCalls[]`. Tool responses serialize into `outputText` and scorer `detail` rides the existing `llmGradeReasoning` channel, so samples/cache/holdout/playoff/reports/UI compose without further plumbing.

**Tech Stack:** existing stack + **ajv** (new `@promptengine/core` dependency; pure JS).

**Spec:** `docs/superpowers/specs/2026-07-29-tool-call-eval-design.md`.

## Global Constraints

- Commit messages: NEVER add attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` suffixes; strict TS; after every task `npx vitest run` green AND bare `npm run type-check`.
- Scoring ladders (verbatim): json_schema — unparseable 0, violating `Math.max(1, 6 - errorCount)`, conformant 10, passed ≥7. tool_call — no call 0, wrong tool 2, right tool wrong args 6, match 10, passed ≥7; `argsMode` default `'subset'`.
- Adapters return `toolCalls` ONLY when the response contains calls; non-tool paths stay byte-identical.
- Repo files are CRLF: any scripted regex edit must use `\r?\n` and verify with grep afterwards.
- Work on branch `tool-call-eval` off `master`.

---

### Task 1: ajv + structured.ts scorers

**Files:**
- Modify: `packages/core/package.json` (add ajv — run `npm install ajv -w @promptengine/core` from repo root)
- Create: `packages/core/src/engine/structured.ts`
- Modify: `packages/core/src/index.ts` (export both scorers)
- Test: `packages/core/tests/engine/structured.test.ts`

**Interfaces:**
- Produces:
  - `scoreJsonSchema(output: string, schema: object | undefined, cacheKey?: string): { passed: boolean; score: number; detail: string }`
  - `scoreToolCall(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined, expected: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' } | undefined): { passed: boolean; score: number; detail: string }`

- [ ] **Step 1: Failing tests** — `packages/core/tests/engine/structured.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scoreJsonSchema, scoreToolCall } from '../../src/engine/structured.js';

const SCHEMA = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string' },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    age: { type: 'number' },
  },
} as object;

describe('scoreJsonSchema', () => {
  it('conformant JSON scores 10 and passes', () => {
    const r = scoreJsonSchema('{"name":"Bob","email":"b@x.co"}', SCHEMA);
    expect(r).toMatchObject({ score: 10, passed: true });
  });

  it('accepts fenced JSON', () => {
    const r = scoreJsonSchema('```json\n{"name":"Bob","email":"b@x.co"}\n```', SCHEMA);
    expect(r.score).toBe(10);
  });

  it('unparseable output scores 0', () => {
    const r = scoreJsonSchema('The contact is Bob (b@x.co)', SCHEMA);
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail).toMatch(/invalid JSON/);
  });

  it('violation count shapes the gradient', () => {
    const oneMissing = scoreJsonSchema('{"name":"Bob"}', SCHEMA);           // missing email
    const twoWrong = scoreJsonSchema('{"age":"old"}', SCHEMA);              // missing both + wrong type
    expect(oneMissing.score).toBeGreaterThan(twoWrong.score);
    expect(oneMissing.passed).toBe(false);
    expect(oneMissing.score).toBeLessThanOrEqual(5);
    expect(twoWrong.score).toBeGreaterThanOrEqual(1);
  });

  it('invalid schema scores 0 without throwing', () => {
    const r = scoreJsonSchema('{}', { type: 'not-a-type' } as object);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/schema error/);
  });

  it('missing schema scores 0 with a config message', () => {
    const r = scoreJsonSchema('{}', undefined);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/no schema/i);
  });
});

const CALL = (name: string, args: Record<string, unknown>) => [{ name, arguments: args }];

describe('scoreToolCall', () => {
  it('no tool call scores 0', () => {
    const r = scoreToolCall(undefined, { name: 'get_weather' });
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail).toMatch(/no tool call/);
  });

  it('wrong tool scores 2', () => {
    const r = scoreToolCall(CALL('get_time', {}), { name: 'get_weather' });
    expect(r).toMatchObject({ score: 2, passed: false });
  });

  it('right tool, wrong args scores 6 with a diff in detail', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'London' }), { name: 'get_weather', args: { city: 'Paris' } });
    expect(r).toMatchObject({ score: 6, passed: false });
    expect(r.detail).toMatch(/Paris/);
    expect(r.detail).toMatch(/London/);
  });

  it('subset match with extra actual keys scores 10', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Paris', units: 'C' }), { name: 'get_weather', args: { city: 'Paris' } });
    expect(r).toMatchObject({ score: 10, passed: true });
  });

  it('exact mode rejects extra keys', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Paris', units: 'C' }),
      { name: 'get_weather', args: { city: 'Paris' }, argsMode: 'exact' });
    expect(r.score).toBe(6);
  });

  it('nested args deep-equal', () => {
    const r = scoreToolCall(CALL('book', { where: { city: 'Paris', floor: 2 } }),
      { name: 'book', args: { where: { city: 'Paris', floor: 2 } } });
    expect(r.score).toBe(10);
  });

  it('name-only expectation: any args score 10', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Oslo' }), { name: 'get_weather' });
    expect(r.score).toBe(10);
  });

  it('first call is judged when multiple', () => {
    const r = scoreToolCall([...CALL('get_time', {}), ...CALL('get_weather', {})], { name: 'get_weather' });
    expect(r.score).toBe(2);
  });

  it('missing expectedTool is a config error scoring 0', () => {
    const r = scoreToolCall(CALL('get_weather', {}), undefined);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/expectedTool/);
  });
});
```

- [ ] **Step 2: Verify failure**, then `npm install ajv -w @promptengine/core`.

- [ ] **Step 3: Create `packages/core/src/engine/structured.ts`**:

```ts
/**
 * Deterministic scorers for the agent-builder test modes. No judge calls:
 * scoring is free, noise-free, and gives evolution a crisp gradient.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { TestCase } from '../types.js';

const ajv = new Ajv({ strict: false, allErrors: true });
const validatorCache = new Map<string, ValidateFunction>();

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return text;
}

export function scoreJsonSchema(
  output: string,
  schema: object | undefined,
  cacheKey?: string,
): { passed: boolean; score: number; detail: string } {
  if (!schema) return { passed: false, score: 0, detail: 'no schema configured on this json_schema test' };

  let validate;
  try {
    validate = cacheKey ? validatorCache.get(cacheKey) : undefined;
    if (!validate) {
      validate = ajv.compile(schema);
      if (cacheKey) validatorCache.set(cacheKey, validate);
    }
  } catch (error) {
    return { passed: false, score: 0, detail: `schema error: ${error instanceof Error ? error.message : error}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(output));
  } catch (error) {
    return { passed: false, score: 0, detail: `invalid JSON: ${error instanceof Error ? error.message : error}` };
  }

  if (validate(parsed)) return { passed: true, score: 10, detail: 'conforms to schema' };

  const errors = validate.errors ?? [];
  const score = Math.max(1, 6 - errors.length);
  const detail = `schema violations (${errors.length}): ` +
    errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
  return { passed: false, score, detail };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

export function scoreToolCall(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined,
  expected: TestCase['expectedTool'],
): { passed: boolean; score: number; detail: string } {
  if (!expected?.name) {
    return { passed: false, score: 0, detail: 'no expectedTool configured on this tool_call test' };
  }
  if (!toolCalls || toolCalls.length === 0) {
    return { passed: false, score: 0, detail: 'no tool call (plain text response)' };
  }

  const call = toolCalls[0]; // first call is judged; sequences are out of scope
  if (call.name !== expected.name) {
    return { passed: false, score: 2, detail: `called ${call.name}, expected ${expected.name}` };
  }
  if (!expected.args) {
    return { passed: true, score: 10, detail: `called ${expected.name} (no argument expectations)` };
  }

  const mode = expected.argsMode ?? 'subset';
  const matches = mode === 'exact'
    ? deepEqual(call.arguments, expected.args)
    : Object.entries(expected.args).every(([k, v]) => deepEqual((call.arguments as any)[k], v));

  if (matches) return { passed: true, score: 10, detail: `called ${expected.name} with matching args (${mode})` };
  return {
    passed: false,
    score: 6,
    detail: `called ${expected.name} but args differ (${mode}): expected ${JSON.stringify(expected.args)}, got ${JSON.stringify(call.arguments)}`,
  };
}
```

- [ ] **Step 4: types.ts additions** (needed for the `TestCase['expectedTool']` reference):
- mode union: `mode: 'llm_grade' | 'exact_match' | 'json_schema' | 'tool_call';`
- after `grading`: `schema?: object; tools?: ToolDef[]; expectedTool?: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' };`
- new near ProviderAdapter: `export interface ToolDef { name: string; description?: string; parameters?: object; }`

- [ ] **Step 5: index.ts** — `export { scoreJsonSchema, scoreToolCall } from './engine/structured.js';` and `export type { ToolDef } from './types.js';` (with the existing type exports).

- [ ] **Step 6: Run** — structured tests green; full suite; bare type-check.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json package-lock.json packages/core/src/engine/structured.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/tests/engine/structured.test.ts
git commit -m "Deterministic scorers for json_schema and tool_call test modes (ajv)"
```

---

### Task 2: Adapter tool translation (all five)

**Files:**
- Modify: `packages/core/src/types.ts` (ProviderAdapter call opts/return), `packages/core/src/providers/base.ts` (same)
- Modify: `packages/core/src/providers/{openai,groq,openrouter,gemini,anthropic}.ts`
- Test: `packages/core/tests/providers/tool-translation.test.ts` (new)

**Interfaces:**
- Consumes: `ToolDef` (Task 1).
- Produces: `call` opts gain `tools?: ToolDef[];`; return gains `toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;` — present ONLY when the response contains calls.

- [ ] **Step 1: Failing tests** (system-role scaffolding: same three vi.mock blocks; fetch stub capturing `lastBody` and returning canned per-provider responses):

```ts
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

  it('no tools in opts => no tools in body; no calls => toolCalls absent', async () => {
    stub({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const r = await new OpenAIAdapter().call({ ...CALL, tools: undefined });
    expect(lastBody.tools).toBeUndefined();
    expect(r.toolCalls).toBeUndefined();
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
});
```

(Groq/OpenRouter share the OpenAI request/response code path — their translation is identical line-for-line; the openai-family describe covers the logic, and both get the same edit. Add one signal-style smoke each if cheap.)

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement**

3a. `types.ts` ProviderAdapter: opts gain `tools?: ToolDef[];` (after `timeoutMs`); return gains `toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;` (after `usd`). Import/refer `ToolDef`. Same two additions in `base.ts` (`callAPI` opts + both return types; `call` return).
3b. OpenAI family (`openai.ts`, `groq.ts`, `openrouter.ts`) — after the body is built, before fetch:
```ts
      if (opts.tools?.length) {
        body.tools = opts.tools.map(t => ({ type: 'function', function: t }));
        body.tool_choice = 'auto';
      }
```
and the return block becomes:
```ts
      const message = data.choices[0]?.message;
      let toolCalls;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc: any) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); }
          catch { console.warn(`[${this.name}] Unparseable tool arguments:`, tc.function?.arguments); }
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
```
(keep each adapter's existing usage-field names — openrouter/groq mirror openai's.)
3c. `gemini.ts` — body gains (next to generationConfig):
```ts
        ...(opts.tools?.length ? { tools: [{ functionDeclarations: opts.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }] } : {}),
```
and parsing replaces the single-part extraction:
```ts
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const output = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('');
      const fnParts = parts.filter((p: any) => p.functionCall);
      const toolCalls = fnParts.length > 0
        ? fnParts.map((p: any) => ({ name: p.functionCall.name, arguments: p.functionCall.args ?? {} }))
        : undefined;
```
with `...(toolCalls ? { toolCalls } : {})` in the returned object (token estimation lines keep using `output`).
3d. `anthropic.ts` — body gains:
```ts
      ...(opts.tools?.length ? { tools: opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters ?? { type: 'object' } })) } : {}),
```
and parsing:
```ts
      const blocks = data.content ?? [];
      const output = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const uses = blocks.filter((b: any) => b.type === 'tool_use');
      const toolCalls = uses.length > 0
        ? uses.map((b: any) => ({ name: b.name, arguments: b.input ?? {} }))
        : undefined;
```
with `...(toolCalls ? { toolCalls } : {})` in the return.

- [ ] **Step 4: Run** — translation tests + full suite (system-role, seed-forwarding, timeout tests must stay green) + bare type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/providers/base.ts packages/core/src/providers/openai.ts packages/core/src/providers/groq.ts packages/core/src/providers/openrouter.ts packages/core/src/providers/gemini.ts packages/core/src/providers/anthropic.ts packages/core/tests/providers/tool-translation.test.ts
git commit -m "Adapters: canonical tool translation and toolCalls normalization (all providers)"
```

---

### Task 3: Engine dispatch + E2E

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts` (`runSingleSample`: pass tools, serialize outputText, two scoring branches)
- Test: `packages/core/tests/engine/structured-e2e.test.ts` (new; fidelity harness)

**Interfaces:**
- Consumes: `scoreJsonSchema`/`scoreToolCall` (Task 1), adapter `tools`/`toolCalls` (Task 2).

- [ ] **Step 1: Failing E2E** — fidelity scaffolding (store mock, registry, tmp DB, event capture). Config: initialSize 1, generationSize 1, maxGenerations 1, seedPrompt `'{"name":"Bob","email":"b@x.co"}'`, three tests:
```ts
    testSet: [
      { id: 's1', name: 'schema', mode: 'json_schema', prompt: 'Extract the contact.',
        schema: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' } } } },
      { id: 'w1', name: 'weather', mode: 'tool_call', prompt: 'Weather in Paris?',
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }, { name: 'get_time', parameters: { type: 'object' } }],
        expectedTool: { name: 'get_weather', args: { city: 'Paris' } } },
      { id: 't1', name: 'time', mode: 'tool_call', prompt: 'Time in Oslo?',
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }, { name: 'get_time', parameters: { type: 'object' } }],
        expectedTool: { name: 'get_time' } },
    ],
```
Fake adapter: when `opts.tools` present → `{ output: '', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], ... }` (always calls get_weather); otherwise echo `opts.system`. Assertions on the finished node's tests:
- s1: score 10, passed true (seed prompt echoes as conformant JSON);
- w1: score 10; `outputText` parses to `{ toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] }`; `llmGradeReasoning` contains `matching args`;
- t1: score 2 (wrong tool — adapter always calls get_weather); reasoning contains `expected get_time`;
- node quality = mean ≈ (10+10+2)/3; run finishes; zero service-model judge calls for these tests (adapter call count == 3).

- [ ] **Step 2: Verify failure** (tools not passed; modes unknown → default score path).

- [ ] **Step 3: Implement in `runSingleSample` + grading block**

3a. Candidate call opts gain: `...(test.mode === 'tool_call' && test.tools?.length ? { tools: test.tools } : {}),`
3b. Immediately after the call returns: `const effectiveOutput = result.toolCalls ? JSON.stringify({ toolCalls: result.toolCalls }, null, 2) : result.output;` — the sample/TestResult `outputText` and downstream references in this function use `effectiveOutput` (locate the assignment `outputText: result.output` and any judge/scoring uses of `result.output` in this scope and switch them; llm_grade/exact_match behavior is unchanged because those tests never produce toolCalls).
3c. After the `exact_match` else-if chain, add:
```ts
    } else if (test.mode === 'json_schema') {
      const { scoreJsonSchema } = await import('./structured.js');
      const r = scoreJsonSchema(effectiveOutput, test.schema as object | undefined, test.id);
      score = r.score; passed = r.passed; llmGradeReasoning = r.detail;
    } else if (test.mode === 'tool_call') {
      const { scoreToolCall } = await import('./structured.js');
      const r = scoreToolCall(result.toolCalls, test.expectedTool);
      score = r.score; passed = r.passed; llmGradeReasoning = r.detail;
    }
```
3d. If an empty-output guard in this path treats `''` as failure, exempt the `result.toolCalls` case.

- [ ] **Step 4: Run** — E2E green; fidelity/seed/resume/checkpoint suites green; bare type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/tests/engine/structured-e2e.test.ts
git commit -m "Engine: json_schema and tool_call scoring with serialized tool outputs"
```

---

### Task 4: CLI passthrough + docs

**Files:**
- Modify: `packages/cli/src/config.ts` (testSet entry type + mapping at the `toEvaluationConfig` testSet map, ~line 171)
- Modify: `docs/cli.md`, `.claude/skills/evolving-prompts/SKILL.md`, `README.md`
- Test: `packages/cli/tests/config.test.ts`

- [ ] **Step 1: Failing test**:

```ts
  it('passes json_schema and tool_call fields through', () => {
    const cfg = toEvaluationConfig({
      seedPrompt: 's',
      testSet: [
        { prompt: 'x', mode: 'json_schema', schema: { type: 'object' } },
        { prompt: 'y', mode: 'tool_call', tools: [{ name: 'f' }], expectedTool: { name: 'f', args: { a: 1 } } },
      ],
    } as any);
    expect(cfg.testSet[0].mode).toBe('json_schema');
    expect(cfg.testSet[0].schema).toEqual({ type: 'object' });
    expect(cfg.testSet[1].tools).toEqual([{ name: 'f' }]);
    expect(cfg.testSet[1].expectedTool).toEqual({ name: 'f', args: { a: 1 } });
  });
```

- [ ] **Step 2: Implement** — CliConfig testSet entry: mode union grows `| 'json_schema' | 'tool_call'`; add `schema?: object; tools?: Array<{ name: string; description?: string; parameters?: object }>; expectedTool?: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' };`. Mapping adds:
```ts
      ...(t.schema ? { schema: t.schema } : {}),
      ...(t.tools ? { tools: t.tools } : {}),
      ...(t.expectedTool ? { expectedTool: t.expectedTool } : {}),
```

- [ ] **Step 3: Docs** — `docs/cli.md` new section "Agent-builder test modes" after "Evaluation fidelity": one full JSON example per mode, both scoring ladders (0 / 1–5 / 10 and 0 / 2 / 6 / 10, passed ≥7), argsMode semantics (subset default: expected keys deep-equal, extras fine; exact: whole-object equality), first-call-judged rule, and "deterministic — no judge calls, zero grading cost". SKILL.md bullet: `- Prompts for agents? Use mode "json_schema" (output must conform to a JSON Schema) and mode "tool_call" (tools + expectedTool: right function, right args) — both deterministic and judge-free, so they're cheap and noise-free. argsMode "subset" (default) ignores extra args.` README: add to the test-set feature bullets: `**Tool-call & schema tests** — evolve prompts whose success is "calls the right function with the right arguments" or "conforms to this JSON Schema". Scored deterministically, no judge needed.`

- [ ] **Step 4: Run + commit**

```bash
git add packages/cli/src/config.ts packages/cli/tests/config.test.ts docs/cli.md .claude/skills/evolving-prompts/SKILL.md README.md
git commit -m "CLI + docs: agent-builder test modes"
```

---

### Task 5: Desktop UI

**Files:**
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (TestSetTab: mode options ~line 1077, conditional editors after the `test.mode === 'exact_match'` block ~line 1094)
- Modify: `apps/desktop/src/components/RightPanel.tsx` (tool-call rendering at the output block ~line 230)

- [ ] **Step 1: TestSetTab** — mode select gains:
```tsx
                  <option value="json_schema">JSON Schema</option>
                  <option value="tool_call">Tool Call</option>
```
Add a small helper component in the file (near TestSetTab) for validated JSON editing — invalid text shows a red border + message and does NOT overwrite the last valid value (config therefore always stays valid; Start needs no extra gating — stricter than the spec's block-on-start and simpler):
```tsx
function JsonField({ label, value, onValid, placeholder }: {
  label: string; value: unknown; onValid: (parsed: any) => void; placeholder: string;
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <textarea
        className={`w-full h-24 rounded border bg-background p-2 font-mono text-xs ${error ? 'border-red-500' : ''}`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') { setError(null); onValid(undefined); return; }
          try { onValid(JSON.parse(e.target.value)); setError(null); }
          catch (err: any) { setError(err.message); }
        }}
      />
      {error && <div className="text-xs text-red-500">Invalid JSON: {error}</div>}
    </div>
  );
}
```
Conditional editors in the test card:
```tsx
            {test.mode === 'json_schema' && (
              <JsonField label="Response Schema (JSON)" value={test.schema}
                onValid={(v) => updateTest(test.id, { schema: v })}
                placeholder='{"type":"object","required":["name"]}' />
            )}
            {test.mode === 'tool_call' && (
              <>
                <JsonField label="Tools (JSON array)" value={test.tools}
                  onValid={(v) => updateTest(test.id, { tools: v })}
                  placeholder='[{"name":"get_weather","parameters":{"type":"object"}}]' />
                <JsonField label="Expected Tool (JSON)" value={test.expectedTool}
                  onValid={(v) => updateTest(test.id, { expectedTool: v })}
                  placeholder='{"name":"get_weather","args":{"city":"Paris"},"argsMode":"subset"}' />
              </>
            )}
```
(adapt `updateTest` to the file's actual per-test update helper — find how the exact_match `expected` field updates tests and use the same function.)

- [ ] **Step 2: RightPanel** — replace the output text node (line ~232) with tool-aware rendering:
```tsx
                          {(() => {
                            try {
                              const parsed = JSON.parse(test.outputText || '');
                              if (parsed && Array.isArray(parsed.toolCalls)) {
                                return parsed.toolCalls.map((tc: any, i: number) => (
                                  <div key={i}>→ {tc.name}({JSON.stringify(tc.arguments)})</div>
                                ));
                              }
                            } catch { /* plain text */ }
                            return test.outputText || 'No output';
                          })()}
```

- [ ] **Step 3: Verify** — bare type-check; desktop tests; rebuild `npm run build:dev -w apps/desktop`; CDP smoke: New Evaluation → Test Set tab: mode select contains `JSON Schema`/`Tool Call`; switching a test to Tool Call shows both JSON editors; typing invalid JSON shows the red error line. Kill electron.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/NewEvaluationModal.tsx apps/desktop/src/components/RightPanel.tsx
git commit -m "Desktop: json_schema/tool_call test editors and tool-call rendering"
```

---

### Task 6: Live double verification

**Files:** none committed (scratchpad only).

- [ ] **Step 1 (tool routing)**: Scratch config — flash-lite candidates+service, seed prompt `"You are an assistant."` (deliberately vague), populationSize 3, generationSize 3, maxGenerations 2, budget 0.03, seed 42, three `tool_call` tests: weather-in-Paris → `get_weather {city: "Paris"}`; time-in-Oslo → `get_time {city: "Oslo"}`; weather-in-Tokyo → `get_weather` (name only). Tools array on each test: both `get_weather` and `get_time` with `{ type:'object', properties:{ city:{type:'string'} }, required:['city'] }`. Run; assert: exit 0, results show real functionCall parsing (outputText with `toolCalls`), scores in {0,2,6,10} only, best fitness ≥ seed fitness, reasoning strings show the scorer details.
- [ ] **Step 2 (schema)**: Scratch config — 2 `json_schema` tests (contact extraction with required name/email; list extraction with array schema), seed prompt asking for JSON, 2 generations. Assert conformant candidates reach 10s and violations show partial scores with ajv messages in reasoning.
- [ ] **Step 3**: Report both; unexpected scoring → STOP and diagnose.
