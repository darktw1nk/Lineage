# Per-Call Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every LLM HTTP call gets an AbortController timeout (default 120s, configurable via `callTimeoutMs`) so a hung request can never pin a semaphore slot indefinitely.

**Architecture:** One shared `fetchWithTimeout` primitive in `providers/retry.ts` rethrows aborts as `RetryableError(…, 408)` — timeouts are retryable with a fresh budget per attempt, capping a node call at `timeoutMs × attempts`. All five adapters consume it; `timeoutMs` rides the existing `call`/`callAPI` opts with an adapter-side guard, and the engine threads `config.callTimeoutMs` through its ten call sites.

**Tech Stack:** existing stack; no new dependencies. `AbortController` is global in Node 18+/Electron.

**Spec:** `docs/superpowers/specs/2026-07-29-per-call-timeout-design.md`.

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By`/attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` suffixes; strict TS; after every task `npx vitest run` green AND bare `npm run type-check` (never piped).
- Guard rule (verbatim): `const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;` — absent/zero/negative ⇒ 120s default.
- Test stubs that simulate hangs MUST honor the abort signal (reject with an `AbortError`-named error on `init.signal` abort) — a signal-deaf pending promise would mask the entire feature.
- Work on branch `call-timeouts` off `master`.

---

### Task 1: fetchWithTimeout primitive

**Files:**
- Modify: `packages/core/src/providers/retry.ts`
- Test: `packages/core/tests/providers/fetch-timeout.test.ts` (new)

**Interfaces:**
- Produces: `export const DEFAULT_CALL_TIMEOUT_MS = 120_000;` and `export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response>`.

- [ ] **Step 1: Failing tests**:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS, RetryableError } from '../../src/providers/retry.js';

// Hang-until-aborted stub: never resolves, but honors the abort signal like real fetch
function hangingFetch() {
  return vi.fn((_url: any, init: any) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchWithTimeout', () => {
  it('aborts a hung request and rethrows as RetryableError(408)', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const started = Date.now();
    await expect(fetchWithTimeout('https://x.test', { method: 'POST' }, 50))
      .rejects.toSatisfy((e: any) =>
        e instanceof RetryableError && e.statusCode === 408 && /timed out after 50ms/.test(e.message));
    expect(Date.now() - started).toBeLessThan(2000); // aborted promptly, not hung
  });

  it('passes a successful response through and forwards the signal', async () => {
    let seenInit: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      seenInit = init;
      return new Response('{"ok":true}', { status: 200 });
    }));
    const res = await fetchWithTimeout('https://x.test', { method: 'GET' }, 5000);
    expect(res.status).toBe(200);
    expect(seenInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('rethrows non-abort errors untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(fetchWithTimeout('https://x.test', {}, 5000)).rejects.toThrow(TypeError);
  });

  it('exports the 120s default', () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project @promptengine/core packages/core/tests/providers/fetch-timeout.test.ts` → exports missing.

- [ ] **Step 3: Implement in retry.ts** (append after `withRetry`):

```ts
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * fetch with a hard per-attempt timeout. A hung request is aborted and rethrown
 * as RetryableError(408) so withRetry gives it a fresh attempt (and a fresh
 * timeout budget); repeated timeouts exhaust retries and fail the call, freeing
 * the global semaphore slot instead of pinning it forever.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new RetryableError(`Request timed out after ${timeoutMs}ms`, 408);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run** — tests green; full suite; bare type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/retry.ts packages/core/tests/providers/fetch-timeout.test.ts
git commit -m "Add fetchWithTimeout: per-attempt abort as retryable 408"
```

---

### Task 2: Adapters consume fetchWithTimeout

**Files:**
- Modify: `packages/core/src/types.ts` (ProviderAdapter.call opts + `timeoutMs?: number`)
- Modify: `packages/core/src/providers/base.ts` (call + callAPI opts gain `timeoutMs?: number`)
- Modify: `packages/core/src/providers/openai.ts:90`, `groq.ts:51`, `openrouter.ts:85` + `:143` (fetchModels, fixed 60s), `gemini.ts:47`, `anthropic.ts:46`
- Test: `packages/core/tests/providers/timeout-forwarding.test.ts` (new)

**Interfaces:**
- Consumes: `fetchWithTimeout`, `DEFAULT_CALL_TIMEOUT_MS` (Task 1).
- Produces: every adapter completion call passes an `AbortSignal` to fetch and honors `opts.timeoutMs` per the guard rule.

- [ ] **Step 1: Failing test** (system-role.test.ts scaffolding — same three vi.mock blocks for store/semaphore/costs):

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
import { GroqAdapter } from '../../src/providers/groq.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const RESPONSES: Record<string, any> = {
  openai: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  anthropic: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
};

let lastInit: any;
function stubFetch(kind: keyof typeof RESPONSES) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastInit = init;
    return new Response(JSON.stringify(RESPONSES[kind]), { status: 200 });
  }));
}

// Hang-until-aborted stub (honors the signal like real fetch)
function stubHangingFetch() {
  vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastInit = undefined; });

const CALL = { model: 'm', prompt: 'IN', temperature: 0.5, maxTokens: 50 };

describe('every adapter passes an AbortSignal', () => {
  const cases: Array<[string, any, keyof typeof RESPONSES]> = [
    ['openai', new OpenAIAdapter(), 'openai'],
    ['groq', new GroqAdapter(), 'openai'],
    ['openrouter', new OpenRouterAdapter(), 'openai'],
    ['anthropic', new AnthropicAdapter(), 'anthropic'],
    ['gemini', new GeminiAdapter(), 'gemini'],
  ];
  for (const [name, adapter, kind] of cases) {
    it(`${name}: fetch receives a signal`, async () => {
      stubFetch(kind);
      await adapter.call({ ...CALL, timeoutMs: 5000 });
      expect(lastInit.signal).toBeInstanceOf(AbortSignal);
    });
  }
});

describe('timeout actually fires and is retryable-then-fatal', () => {
  it('a hung request rejects with a timed-out error instead of hanging', async () => {
    stubHangingFetch();
    // timeoutMs 30: each withRetry attempt aborts after 30ms; backoff sleeps are
    // real but capped by initialDelayMs growth — keep the test tolerant on time,
    // strict on outcome.
    await expect(new OpenAIAdapter().call({ ...CALL, timeoutMs: 30 }))
      .rejects.toThrow(/timed out after 30ms/);
  }, 30000);
});
```

- [ ] **Step 1b: Semaphore-release test** — `packages/core/tests/providers/semaphore-release.test.ts` (REAL semaphore, mocked store/costs only — this is the spec's core claim: a timed-out call frees its slot):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => 'test-key-1234', set: () => {}, store: {} },
  setStore: vi.fn(),
}));
vi.mock('../../src/providers/costs.js', () => ({
  getModelCost: async () => ({ provider: 'openai', model: 'm', promptUSDper1k: 0, completionUSDper1k: 0 }),
}));

import { OpenAIAdapter } from '../../src/providers/openai.js';
import { initGlobalSemaphore } from '../../src/engine/semaphore.js';

afterEach(() => vi.unstubAllGlobals());

it('a timed-out call releases its semaphore slot (follow-up call runs)', async () => {
  initGlobalSemaphore(1); // single slot: a leak would deadlock the second call
  let mode: 'hang' | 'ok' = 'hang';
  vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => {
    if (mode === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(new Response(JSON.stringify(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
  }));

  const adapter = new OpenAIAdapter();
  await expect(adapter.call({ model: 'm', prompt: 'IN', temperature: 0, maxTokens: 10, timeoutMs: 30 }))
    .rejects.toThrow(/timed out/); // exhausts retries (~7s of real backoff)

  mode = 'ok';
  const result = await adapter.call({ model: 'm', prompt: 'IN', temperature: 0, maxTokens: 10, timeoutMs: 5000 });
  expect(result.output).toBe('ok'); // slot was freed — no deadlock
}, 30000);
```

- [ ] **Step 2: Run to verify failure** — `timeoutMs` not accepted / no signal forwarded (the hang tests would time out without the feature — vitest kills them at 30s, also a failure).

- [ ] **Step 3: Implement**

3a. `types.ts` ProviderAdapter `call` opts: add `timeoutMs?: number;` (next to `seed?`).
3b. `base.ts`: add `timeoutMs?: number;` to both the `callAPI` abstract opts and the public `call` opts (it flows through the existing `...opts` spread).
3c. Each adapter (`openai.ts`, `groq.ts`, `openrouter.ts`, `gemini.ts`, `anthropic.ts`), near the top of `callAPI`:
```ts
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
```
with `import { withRetry, RetryableError, fetchWithTimeout, DEFAULT_CALL_TIMEOUT_MS } from './retry.js';` (keep existing named imports), and each completion `await fetch(URL, { ... })` becomes `await fetchWithTimeout(URL, { ... }, timeoutMs)`. Each adapter's opts type (the inline `opts:` object in its callAPI signature) gains `timeoutMs?: number;` if it declares its own literal type.
3d. `openrouter.ts:143` (`fetchModels`): `await fetchWithTimeout('https://openrouter.ai/api/v1/models', { headers }, 60_000);`

- [ ] **Step 4: Run** — forwarding tests green (the hang test proves end-to-end abort through withRetry); full suite (system-role + seed-forwarding tests must stay green — their stubs don't set signal expectations); bare type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/providers/base.ts packages/core/src/providers/openai.ts packages/core/src/providers/groq.ts packages/core/src/providers/openrouter.ts packages/core/src/providers/gemini.ts packages/core/src/providers/anthropic.ts packages/core/tests/providers/timeout-forwarding.test.ts packages/core/tests/providers/semaphore-release.test.ts
git commit -m "Adapters: AbortSignal timeout on every LLM fetch (default 120s)"
```

---

### Task 3: Engine + CLI plumbing, docs

**Files:**
- Modify: `packages/core/src/types.ts` (`EvaluationConfig.callTimeoutMs`)
- Modify: `packages/core/src/engine/evaluator_v2.ts:831`, `packages/core/src/engine/fitness.ts:188,259,385` (+ both helper signatures), `packages/core/src/engine/crossover.ts:58`, `packages/core/src/engine/pairwise.ts:111`, `packages/core/src/engine/mutations.ts:197,245`, `packages/core/src/engine/metaprompting.ts:183,216`
- Modify: `packages/cli/src/config.ts` (CliConfig + mapping)
- Modify: `docs/cli.md`, `.claude/skills/evolving-prompts/SKILL.md`
- Test: `packages/cli/tests/config.test.ts` (addition)

**Interfaces:**
- Consumes: `timeoutMs` in call opts (Task 2).
- Produces: `EvaluationConfig.callTimeoutMs?: number;`; `evaluateSafetyGuardrails(..., maxTokens?, timeoutMs?)` and `evaluateTestResultLLM(..., maxTokens?, timeoutMs?)` (appended optional params).

- [ ] **Step 1: Failing CLI test** (append to the toEvaluationConfig describe):

```ts
  it('passes callTimeoutMs through', () => {
    const evalConfig = toEvaluationConfig({
      seedPrompt: 'test', testSet: [{ prompt: 'x' }], callTimeoutMs: 30000,
    } as CliConfig);
    expect(evalConfig.callTimeoutMs).toBe(30000);
  });
```

- [ ] **Step 2: Implement**

2a. `types.ts`: `callTimeoutMs?: number; // per-attempt LLM call timeout in ms (default 120000)` after `seed`.
2b. Ten call sites — add one line to each opts object: `timeoutMs: config.callTimeoutMs,` (in `evaluator_v2.ts:831` it's `state.config.callTimeoutMs`). For `fitness.ts:188/385` (inside `evaluateSafetyGuardrails` / `evaluateTestResultLLM`, which receive `serviceModel/adapter/maxTokens` rather than config): append `timeoutMs?: number` after `maxTokens` in both signatures, pass it in their `adapter.call` opts, and update their call sites (in `evaluator_v2.ts` — find them via `evaluateSafetyGuardrails(` / `evaluateTestResultLLM(`) to pass `state.config.callTimeoutMs` as the new argument. `fitness.ts:259` — check whose scope it's in (it is inside one of the two helpers or has config; thread the same way).
2c. `packages/cli/src/config.ts`: `callTimeoutMs?: number;  // per-attempt LLM call timeout in ms` in CliConfig; mapping: `...(config.callTimeoutMs !== undefined ? { callTimeoutMs: config.callTimeoutMs } : {}),`
2d. Docs — `docs/cli.md` fidelity section bullet:
```markdown
- `"callTimeoutMs": 120000` (the default) aborts any single LLM HTTP attempt after that long — a hung request is retried with a fresh budget instead of stalling a parallel slot forever (worst case per call: timeout × retries). Raise it for slow reasoning models; lower it for fast models on flaky networks.
```
`.claude/skills/evolving-prompts/SKILL.md`, after the resume bullet: `- Hanging provider or flaky network? Every call has a 120s abort timeout (retried, then the node fails and the run continues). Tune with \`"callTimeoutMs"\` — raise for slow reasoning models.`

- [ ] **Step 3: Run** — CLI + full suite green; bare type-check.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/engine/evaluator_v2.ts packages/core/src/engine/fitness.ts packages/core/src/engine/crossover.ts packages/core/src/engine/pairwise.ts packages/core/src/engine/mutations.ts packages/core/src/engine/metaprompting.ts packages/cli/src/config.ts packages/cli/tests/config.test.ts docs/cli.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "Thread callTimeoutMs through engine call sites, CLI, and docs"
```

---

### Task 4: Desktop input

**Files:**
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (Evaluation harness section, after the Seed input)

- [ ] **Step 1: Implement**:

```tsx
        <div>
          <LabelWithTooltip
            htmlFor="callTimeout"
            label="Call Timeout (seconds)"
            tooltip="Hard abort for any single LLM HTTP attempt. Timed-out calls are retried with a fresh budget; repeated timeouts fail the node and the run continues. Default 120s — raise for slow reasoning models."
          />
          <Input
            id="callTimeout"
            type="number"
            min="1"
            value={(config.callTimeoutMs ?? 120000) / 1000}
            onChange={(e) => {
              const s = parseInt(e.target.value, 10);
              setConfig({ ...config, callTimeoutMs: Number.isNaN(s) ? undefined : s * 1000 });
            }}
          />
        </div>
```

- [ ] **Step 2: Verify** — bare type-check; desktop tests; rebuild `npm run build:dev -w apps/desktop`; CDP smoke (open modal → Advanced → Service tab, assert `#callTimeout` exists with value 120; Radix tabs need the full pointer event sequence); kill electron.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/NewEvaluationModal.tsx
git commit -m "Desktop: call timeout input in evaluation harness"
```

---

### Task 5: Live both-ways verification

**Files:** none committed (scratchpad only).

- [ ] **Step 1**: Scratch config: flash-lite, 2 tests, populationSize 2, maxGenerations 1, `"callTimeoutMs": 5`. Run via CLI. Assert: finishes (no hang) within ~2 minutes, stderr contains `timed out after 5ms` retry lines, process exits nonzero (no usable best) — graceful failure, not a freeze.
- [ ] **Step 2**: Same config without `callTimeoutMs` — completes normally, exit 0.
- [ ] **Step 3**: Report both outcomes; a hang in Step 1 = the feature failed — STOP and diagnose.
