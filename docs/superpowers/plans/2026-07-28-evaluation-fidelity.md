# Evaluation Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Candidate prompts evaluate as real system messages (default), each test can average N samples against judge noise, and a holdout split reports seed-vs-champion generalization on tests evolution never saw.

**Architecture:** `system?: string` flows through `ProviderAdapter.call` into each adapter's native mechanism; `runTests` in `evaluator_v2.ts` is refactored around a `runSingleSample` helper that the samples loop and the post-run holdout evaluation both reuse; a pure `partitionTestSet` module splits fitness vs holdout tests at `startEvaluation`; results flow through a new `holdout_result` event into CLI results/report and the desktop Footer.

**Tech Stack:** existing stack (TypeScript 5.3 strict ESM, Vitest 4). No new dependencies — the seeded PRNG is a 6-line mulberry32.

**Spec:** `docs/superpowers/specs/2026-07-28-evaluation-fidelity-design.md` — normative for anything not repeated here.

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By` or any attribution trailer.
- Never `git add -A` / `git add .` — stage exact paths only.
- ESM; relative imports keep `.js` extension. `packages/core` never imports electron.
- After every task: full `npx vitest run` green AND `npm run type-check` clean.
- Defaults locked by spec: `promptMode` absent ⇒ `'system'`; `samplesPerTest` absent ⇒ 1 (clamp 1..10 with warning); `holdoutShare` absent ⇒ 0; `holdoutSeed` absent ⇒ 42.
- `passed` semantics with samples: `llm_grade` → mean ≥ 7; `exact_match` strict mode → strict majority of exact matches; `exact_match` distance mode → mean ≥ 7.
- Service-model calls (mutation/crossover/meta/judge/safety) are UNCHANGED.
- Commands run from repo root via the Bash tool; work on a `evaluation-fidelity` branch off `master`.

---

### Task 1: Types + system-role support in all five adapters

**Files:**
- Modify: `packages/core/src/types.ts` (all type changes for the whole phase)
- Modify: `packages/core/src/providers/base.ts` (`callAPI` opts + pass-through in `call`)
- Modify: `packages/core/src/providers/openai.ts:59-62`, `anthropic.ts:33-38`, `gemini.ts:32-38`, `groq.ts:31-37`, `openrouter.ts:57-62`
- Test: `packages/core/tests/providers/system-role.test.ts` (new)

**Interfaces:**
- Produces (everything later tasks use):
  - `ProviderAdapter.call(opts)` and `BaseProviderAdapter.callAPI(opts)` accept `system?: string`.
  - `EvaluationConfig` gains `promptMode?: 'system' | 'inline'`, `samplesPerTest?: number`, `holdoutShare?: number`, `holdoutSeed?: number`.
  - `TestCase` gains `holdout?: boolean`.
  - `TestResult` gains `samples?: number[]`.
  - `EvaluationRun` gains:
    ```ts
    holdout?: {
      testIds: UUID[];
      samplesPerTest: number;
      seed?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
      champion?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
      skipped?: 'budget' | 'no-champion';
    };
    ```

- [ ] **Step 1: Write the failing adapter tests** — `packages/core/tests/providers/system-role.test.ts`:

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

// Minimal OK responses per provider shape
const RESPONSES: Record<string, any> = {
  openai: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  anthropic: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
};

let lastBody: any;
function stubFetch(kind: keyof typeof RESPONSES) {
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify(RESPONSES[kind]), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { lastBody = undefined; });

const CALL = { model: 'm', prompt: 'USER INPUT', temperature: 0.5, maxTokens: 50 };

describe('system-role placement', () => {
  it('openai: system message prepended', async () => {
    stubFetch('openai');
    await new OpenAIAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
    expect(lastBody.messages[1].role).toBe('user');
  });

  it('openai: no system key when absent (unchanged payload)', async () => {
    stubFetch('openai');
    await new OpenAIAdapter().call(CALL);
    expect(lastBody.messages).toHaveLength(1);
    expect(lastBody.messages[0].role).toBe('user');
  });

  it('groq + openrouter: system message prepended', async () => {
    stubFetch('openai'); // same response shape
    await new GroqAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
    stubFetch('openai');
    await new OpenRouterAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'SYS PROMPT' });
  });

  it('anthropic: top-level system parameter', async () => {
    stubFetch('anthropic');
    await new AnthropicAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.system).toBe('SYS PROMPT');
    expect(lastBody.messages[0].role).toBe('user');
  });

  it('gemini: systemInstruction', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call({ ...CALL, system: 'SYS PROMPT' });
    expect(lastBody.systemInstruction).toEqual({ parts: [{ text: 'SYS PROMPT' }] });
    expect(lastBody.contents[0].parts[0].text).toBe('USER INPUT');
  });

  it('gemini: no systemInstruction key when absent', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call(CALL);
    expect(lastBody.systemInstruction).toBeUndefined();
  });
});
```

Before running, check each adapter's response parsing (e.g. anthropic reads `data.content[0].text`, gemini reads `candidates[0].content.parts`) and adjust the RESPONSES stubs to whatever the adapters actually consume — fix the STUBS, not the adapters. Existing `adapters.test.ts` shows the shapes.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @promptengine/core packages/core/tests/providers/system-role.test.ts`
Expected: FAIL — `system` ignored; assertions on messages[0]/system/systemInstruction fail.

- [ ] **Step 3: Type changes** — `packages/core/src/types.ts`:

In `ProviderAdapter.call` opts (and mirror in `base.ts` `callAPI` opts): add `system?: string;` after `prompt`.
In `EvaluationConfig` after `providerOptions`: 

```ts
  promptMode?: 'system' | 'inline'; // default 'system': candidate prompt as system message
  samplesPerTest?: number;          // default 1 (clamped 1..10): samples averaged per test
  holdoutShare?: number;            // default 0: seeded share of non-flagged tests held out
  holdoutSeed?: number;             // default 42: PRNG seed for the share split
```

In `TestCase` after `image`: `holdout?: boolean; // excluded from fitness; used for the final generalization report`
In `TestResult` after `llmGradeReasoning`: `samples?: number[]; // individual sample scores when samplesPerTest > 1`
In `EvaluationRun` after `cacheHits` (exact shape from Interfaces block above).

- [ ] **Step 4: Adapter edits** (each: add `system` to the `callAPI` opts type where declared):

`base.ts`: `callAPI` abstract opts gains `system?: string;`; in `call()`, the spread `...opts` already forwards it — verify and leave.

`openai.ts:59-62`:
```ts
      const body: any = {
        model: opts.model,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: messageContent },
        ],
      };
```

`groq.ts:31-37` and `openrouter.ts:57-62`: same pattern — spread a conditional system message ahead of the user message in `messages`.

`anthropic.ts:33-38`:
```ts
      const body: any = {
        model: opts.model,
        messages: [{ role: 'user', content: opts.prompt }],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens ?? 4096,
      };
      if (opts.system) {
        body.system = opts.system;
      }
```
(change `const body = {` to `const body: any = {` if needed.)

`gemini.ts:32-38`:
```ts
      const body: any = {
        contents: [{ parts: [{ text: opts.prompt }] }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens ?? 4096,
        },
      };
      if (opts.system) {
        body.systemInstruction = { parts: [{ text: opts.system }] };
      }
```
(gemini image handling: if the contents parts are built elsewhere for images, keep that logic — only ADD the systemInstruction block.)

- [ ] **Step 5: Run tests** — system-role tests PASS; full suite green (`npx vitest run`); `npm run type-check` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/providers/base.ts packages/core/src/providers/openai.ts packages/core/src/providers/anthropic.ts packages/core/src/providers/gemini.ts packages/core/src/providers/groq.ts packages/core/src/providers/openrouter.ts packages/core/tests/providers/system-role.test.ts
git commit -m "Add system-role support to all provider adapters"
```

---

### Task 2: Holdout partition module

**Files:**
- Create: `packages/core/src/engine/holdout.ts`
- Test: `packages/core/tests/engine/holdout.test.ts`

**Interfaces:**
- Produces: `partitionTestSet(testSet: TestCase[], holdoutShare: number, holdoutSeed: number): { fitnessTests: TestCase[]; holdoutTests: TestCase[] }` — pure, deterministic.

- [ ] **Step 1: Write the failing test** — `packages/core/tests/engine/holdout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { partitionTestSet } from '../../src/engine/holdout.js';
import type { TestCase } from '../../src/types.js';

const t = (id: string, holdout?: boolean): TestCase =>
  ({ id, name: id, mode: 'exact_match', prompt: 'p', expected: 'e', ...(holdout ? { holdout } : {}) }) as TestCase;

describe('partitionTestSet', () => {
  it('flagged tests are always held out', () => {
    const { fitnessTests, holdoutTests } = partitionTestSet([t('a'), t('b', true), t('c')], 0, 42);
    expect(holdoutTests.map(x => x.id)).toEqual(['b']);
    expect(fitnessTests.map(x => x.id)).toEqual(['a', 'c']);
  });

  it('share splits the remaining tests deterministically', () => {
    const tests = [t('a'), t('b'), t('c'), t('d'), t('e'), t('f'), t('g'), t('h'), t('i'), t('j')];
    const one = partitionTestSet(tests, 0.3, 42);
    const two = partitionTestSet(tests, 0.3, 42);
    expect(one.holdoutTests.map(x => x.id)).toEqual(two.holdoutTests.map(x => x.id)); // same seed → same split
    expect(one.holdoutTests).toHaveLength(3); // floor(10 * 0.3)

    const three = partitionTestSet(tests, 0.3, 7);
    expect(three.holdoutTests.map(x => x.id)).not.toEqual(one.holdoutTests.map(x => x.id)); // different seed → different split
  });

  it('flags and share compose (share applies to the non-flagged remainder)', () => {
    const tests = [t('a', true), t('b'), t('c'), t('d'), t('e')]; // 1 flagged + 4 remaining
    const { fitnessTests, holdoutTests } = partitionTestSet(tests, 0.5, 42);
    expect(holdoutTests.some(x => x.id === 'a')).toBe(true);
    expect(holdoutTests).toHaveLength(1 + 2); // flagged + floor(4 * 0.5)
    expect(fitnessTests).toHaveLength(2);
  });

  it('share 0 and no flags → everything is fitness', () => {
    const { fitnessTests, holdoutTests } = partitionTestSet([t('a'), t('b')], 0, 42);
    expect(fitnessTests).toHaveLength(2);
    expect(holdoutTests).toHaveLength(0);
  });

  it('preserves original test order within each partition', () => {
    const tests = [t('a'), t('b', true), t('c'), t('d')];
    const { fitnessTests } = partitionTestSet(tests, 0, 42);
    expect(fitnessTests.map(x => x.id)).toEqual(['a', 'c', 'd']);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `packages/core/src/engine/holdout.ts`**:

```ts
/**
 * Holdout partitioning: tests flagged `holdout: true` are always reserved;
 * `holdoutShare` additionally reserves a seeded-random fraction of the
 * remaining tests. Deterministic for a given (testSet order, share, seed).
 */
import type { TestCase } from '../types.js';

/** mulberry32 — tiny deterministic PRNG, good enough for shuffling. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function partitionTestSet(
  testSet: TestCase[],
  holdoutShare: number,
  holdoutSeed: number,
): { fitnessTests: TestCase[]; holdoutTests: TestCase[] } {
  const flagged = testSet.filter(t => t.holdout === true);
  const remaining = testSet.filter(t => t.holdout !== true);

  const share = Math.min(Math.max(holdoutShare || 0, 0), 1);
  const takeCount = Math.floor(remaining.length * share);

  let sharePicked: TestCase[] = [];
  if (takeCount > 0) {
    const rand = mulberry32(holdoutSeed);
    const shuffled = [...remaining];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const pickedIds = new Set(shuffled.slice(0, takeCount).map(t => t.id));
    sharePicked = remaining.filter(t => pickedIds.has(t.id)); // original order
  }

  const holdoutIds = new Set([...flagged, ...sharePicked].map(t => t.id));
  return {
    fitnessTests: testSet.filter(t => !holdoutIds.has(t.id)),
    holdoutTests: testSet.filter(t => holdoutIds.has(t.id)),
  };
}
```

- [ ] **Step 4: Run tests** — PASS. Export from core index (`packages/core/src/index.ts`): `export { partitionTestSet } from './engine/holdout.js';`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/holdout.ts packages/core/src/index.ts packages/core/tests/engine/holdout.test.ts
git commit -m "Add deterministic holdout partitioning"
```

---

### Task 3: Evaluator — samples loop, promptMode, fitness-tests wiring

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts` (state fields, `startEvaluation` setup, `runTests` refactor around lines 640-804)
- Test: `packages/core/tests/engine/fidelity.test.ts` (new)

**Interfaces:**
- Consumes: `partitionTestSet` (Task 2); `system` call param (Task 1).
- Produces:
  - `EvaluationState` gains `fitnessTests: TestCase[]`, `holdoutTests: TestCase[]`, `samplesPerTest: number` (resolved+clamped), `promptMode: 'system' | 'inline'` (resolved).
  - Exported helper `runSingleSample(opts: { adapter: ProviderAdapter; test: TestCase; candidatePrompt: string; params: CandidateParams; sampleIndex: number; state: EvaluationState-like; runId: UUID; maxTokens: number }) — internal; Task 4 relies on the sibling export below.`
  - Exported `evaluatePromptOnTests(prompt: string, params: CandidateParams, tests: TestCase[], state, runId): Promise<TestResult[]>` — runs the full sample-aggregation pipeline for an arbitrary prompt (used by holdout in Task 4). Costs accrue to `state.run.totals` and emit `totals` events, exactly like normal evaluation.

- [ ] **Step 1: Write the failing tests** — `packages/core/tests/engine/fidelity.test.ts` (drives via a fake provider registered through the registry — no fetch mocks):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import { setSendUpdate, startEvaluation } from '../../src/engine/evaluator_v2.js';
import type { ProviderAdapter } from '../../src/types.js';

interface CallRecord { system?: string; prompt: string; seed?: number; }
let calls: CallRecord[] = [];

function fakeAdapter(output: (c: CallRecord) => string): ProviderAdapter {
  return {
    name: 'fake',
    estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      const rec = { system: opts.system, prompt: opts.prompt, seed: opts.seed };
      calls.push(rec);
      return { output: output(rec), promptTokens: 2, completionTokens: 3, latencyMs: 5, usd: 0.001 };
    },
  };
}

function makeConfig(overrides: any = {}) {
  return {
    id: 'f-cfg', name: 'fidelity',
    selection: { policy: 'topk', topK: 1 },
    operators: { mutationShare: 0, crossoverShare: 0 },
    population: { initialSize: 1, generationSize: 1, seedPrompt: 'SEED SYSTEM PROMPT', fill: 'auto' },
    enabledModels: [{ provider: 'fake', model: 'fake-1' }],
    testSet: [{ id: 't1', name: 'one', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 1 },
    serviceModel: { provider: 'fake', model: 'fake-1' },
    parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
    ...overrides,
  } as any;
}

async function runOnce(config: any): Promise<any[]> {
  const tmpDb = path.join(os.tmpdir(), `pe-fid-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run = {
    id: 'r-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [], cacheHits: 0, version: '1.0',
  } as any;
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, data) => {
    events.push(data);
    if (data.type === 'status' && data.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return events;
}

beforeEach(() => { resetRegistry(); calls = []; });

describe('promptMode', () => {
  it("default 'system': candidate prompt in system, test input as user prompt", async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    await runOnce(makeConfig());
    const evalCalls = calls.filter(c => c.prompt === 'INPUT ONE');
    expect(evalCalls.length).toBeGreaterThan(0);
    expect(evalCalls[0].system).toBe('SEED SYSTEM PROMPT');
  });

  it("'inline': concatenated single prompt, no system", async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    await runOnce(makeConfig({ promptMode: 'inline' }));
    const evalCalls = calls.filter(c => c.prompt.includes('INPUT ONE'));
    expect(evalCalls[0].prompt).toBe('SEED SYSTEM PROMPT\n\nINPUT ONE');
    expect(evalCalls[0].system).toBeUndefined();
  });
});

describe('samplesPerTest', () => {
  it('runs N samples, averages scores, records the samples array', async () => {
    // Alternate outputs: exact match on even calls only → scores 10,0,10 → mean 6.67
    let n = 0;
    registerProvider({ adapter: fakeAdapter(() => (n++ % 2 === 0 ? 'INPUT ONE' : 'WRONG')) });
    const events = await runOnce(makeConfig({
      samplesPerTest: 3,
      testSet: [{ id: 't1', name: 'one', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE',
                  grading: { strictZeroOnDeviation: true } }],
    }));
    const node = events.filter(e => e.type === 'node_updated').map(e => e.node).find(nd => nd.tests?.length);
    const tr = node.tests[0];
    expect(tr.samples).toHaveLength(3);
    expect(tr.score).toBeCloseTo((10 + 0 + 10) / 3, 5);
    expect(tr.passed).toBe(true); // strict majority: 2/3 exact
    expect(tr.promptTokens).toBe(6); // summed 2*3
  });

});
```

Note on the seed+i case: assert it through `evaluatePromptOnTests` directly once exported — add after implementation:

```ts
describe('evaluatePromptOnTests', () => {
  it('is callable with an arbitrary prompt and uses seed+i per sample', async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) });
    const tmpDb = path.join(os.tmpdir(), `pe-fid2-${process.pid}.db`);
    await initializeDatabase(tmpDb);
    const { evaluatePromptOnTests } = await import('../../src/engine/evaluator_v2.js');
    const state: any = {
      config: makeConfig({ samplesPerTest: 2 }),
      run: { totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, cacheHits: 0 },
      samplesPerTest: 2, promptMode: 'system',
      gradingTotal: 0, gradingFailures: 0,
    };
    const results = await evaluatePromptOnTests(
      'ANY PROMPT', { model: { provider: 'fake', model: 'fake-1' }, temperature: 0.5, seed: 100 },
      state.config.testSet, state, 'run-x',
    );
    expect(results[0].samples).toHaveLength(2);
    expect(calls.map(c => c.seed)).toEqual([100, 101]);
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure** — default-system test fails (candidate prompt arrives concatenated, `system` undefined); samples test fails (`samples` undefined, single call).

- [ ] **Step 3: Refactor `evaluator_v2.ts`**

3a. `EvaluationState` gains:
```ts
  fitnessTests: TestCase[];
  holdoutTests: TestCase[];
  samplesPerTest: number;
  promptMode: 'system' | 'inline';
```
(`TestCase` imported as type.)

3b. In `startEvaluation`, when constructing the state object:
```ts
  const rawSamples = config.samplesPerTest ?? 1;
  const samplesPerTest = Math.min(Math.max(Math.floor(rawSamples), 1), 10);
  if (samplesPerTest !== rawSamples) {
    console.warn(`[Evaluator] samplesPerTest clamped from ${rawSamples} to ${samplesPerTest}`);
  }
  const { partitionTestSet } = await import('./holdout.js');
  const { fitnessTests, holdoutTests } = partitionTestSet(config.testSet, config.holdoutShare ?? 0, config.holdoutSeed ?? 42);
  if (fitnessTests.length === 0) {
    throw new Error('Holdout configuration leaves no fitness tests');
  }
  if (holdoutTests.length > 0) {
    console.log(`[Evaluator] Holdout: ${holdoutTests.length} test(s) reserved (${holdoutTests.map(t => t.name).join(', ')})`);
  }
```
and add to the state literal: `fitnessTests, holdoutTests, samplesPerTest, promptMode: config.promptMode ?? 'system',`.
(`startEvaluation` is already async; if the throw needs to surface to hosts, it already does — CLI catches sync setup errors, handlers.ts wraps in try/catch.)

3c. Refactor `runTests` (lines 640-804). Replace the body with a structure built on two new module-level functions (place them above `runTests`):

```ts
async function runSingleSample(
  test: TestCase,
  candidatePrompt: string,
  params: CandidateParams,
  sampleIndex: number,
  state: EvaluationState,
  runId: UUID,
  adapter: ProviderAdapter,
  maxTokens: number,
): Promise<{ score: number; exact: boolean; passed: boolean; output: string; reasoning?: string;
             promptTokens: number; completionTokens: number; latencyMs: number }> {
  // Build the call per promptMode
  const system = state.promptMode === 'system' ? candidatePrompt : undefined;
  const prompt = state.promptMode === 'system' ? test.prompt : `${candidatePrompt}\n\n${test.prompt}`;
  const seed = params.seed !== undefined ? params.seed + sampleIndex : undefined;

  // (image loading block moves here unchanged from current lines 661-674)

  const result = await adapter.call({
    model: params.model.model,
    prompt,
    system,
    temperature: params.temperature,
    seed,
    maxTokens,
    providerOptions: state.config.providerOptions,
    images,
  });

  // totals accounting + totals event — exactly the current lines 686-696

  // grading — exactly the current llm_grade / exact_match logic (lines 698-781),
  // except: also return `exact` = (test.mode === 'exact_match' && result.output.trim() === test.expected?.trim())
  return { score, exact, passed, output: result.output, reasoning: llmGradeReasoning,
           promptTokens: result.promptTokens, completionTokens: result.completionTokens, latencyMs: result.latencyMs };
}

export async function evaluatePromptOnTests(
  prompt: string,
  params: CandidateParams,
  tests: TestCase[],
  state: EvaluationState,
  runId: UUID,
): Promise<TestResult[]> {
  const adapter = getProviderAdapter(params.model.provider);
  const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;
  return Promise.all(tests.map(async (test) => {
    const samples = await Promise.all(
      Array.from({ length: state.samplesPerTest }, (_v, i) =>
        runSingleSample(test, prompt, params, i, state, runId, adapter, maxTokens)),
    );
    const mean = samples.reduce((a, s) => a + s.score, 0) / samples.length;
    let passed: boolean;
    if (test.mode === 'exact_match' && test.grading?.strictZeroOnDeviation) {
      passed = samples.filter(s => s.exact).length * 2 > samples.length; // strict majority
    } else {
      passed = mean >= 7;
    }
    const testResult: TestResult = {
      testId: test.id,
      passed,
      score: mean,
      promptTokens: samples.reduce((a, s) => a + s.promptTokens, 0),
      completionTokens: samples.reduce((a, s) => a + s.completionTokens, 0),
      latencyMs: samples.reduce((a, s) => a + s.latencyMs, 0) / samples.length,
      outputText: samples[0].output,
      llmGradeReasoning: samples[0].reasoning,
      ...(state.samplesPerTest > 1 ? { samples: samples.map(s => s.score) } : {}),
    };
    return testResult;
  }));
}
```

`runTests` itself becomes: cache-key computation (extended: `|${state.promptMode}|${state.samplesPerTest}` appended, and `testSetSig` built from `state.fitnessTests`), cache check (unchanged), then `const results = await evaluatePromptOnTests(node.prompt, node.params, state.fitnessTests, state, runId);`, cache set, return.

Note: the cache is per-run state and `promptMode`/`samplesPerTest` are per-run constants, so the key extension is defensive documentation rather than observable behavior — no dedicated test for it (conscious deviation from the spec's testing list).

IMPORTANT semantics preserved: `llm_grade` passed threshold stays `score >= 7` per sample-mean (the existing `evaluateTestResultLLM` returns per-sample `passed` — ignore it, use the mean rule); grading-failure circuit-breaker counters (`state.gradingTotal`/`gradingFailures`, current lines 736-741) move INTO `runSingleSample`'s llm_grade branch unchanged.

- [ ] **Step 4: Run tests** — fidelity tests PASS; the full suite must stay green (generation/evaluator behavior for default configs is unchanged: promptMode default changes the CALL SHAPE, which only the new tests inspect; existing tests use mocked adapters that ignore `system`). Investigate any regression rather than adjusting old tests — EXCEPTION: if an existing test asserts the exact concatenated prompt string reaching the adapter, update that assertion to the new system/user split (that's the intended behavior change).
- Run: `npm run type-check` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/tests/engine/fidelity.test.ts
git commit -m "Evaluator: system-role harness, samples-per-test averaging, fitness/holdout partition"
```

---

### Task 4: Holdout end-evaluation + event

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts` (`finishEvaluation` + call sites)
- Test: extend `packages/core/tests/engine/fidelity.test.ts`

**Interfaces:**
- Consumes: `evaluatePromptOnTests` (Task 3), `EvaluationRun['holdout']` type (Task 1).
- Produces: `sendUpdate(runId, { type: 'holdout_result', holdout })` emitted before the `stop`/`status: finished` events; `state.run.holdout` persisted in the run row.

- [ ] **Step 1: Write the failing test** (append to fidelity.test.ts):

```ts
describe('holdout generalization', () => {
  it('evaluates seed and champion on held-out tests and emits holdout_result', async () => {
    registerProvider({ adapter: fakeAdapter(c => c.prompt) }); // echo → exact_match passes when expected === input
    const events = await runOnce(makeConfig({
      targets: { maxGenerations: 1 },
      testSet: [
        { id: 'fit1', name: 'fitness test', mode: 'exact_match', prompt: 'INPUT ONE', expected: 'INPUT ONE' },
        { id: 'hold1', name: 'holdout test', mode: 'exact_match', prompt: 'UNSEEN INPUT', expected: 'UNSEEN INPUT', holdout: true },
      ],
    }));

    // Holdout test must never run during generations: no eval call before holdout phase used it
    const holdoutEvent = events.find(e => e.type === 'holdout_result');
    expect(holdoutEvent).toBeDefined();
    expect(holdoutEvent.holdout.testIds).toEqual(['hold1']);
    expect(holdoutEvent.holdout.champion.score).toBeCloseTo(10, 5); // echo matches expected
    expect(holdoutEvent.holdout.seed.score).toBeCloseTo(10, 5);
    expect(holdoutEvent.holdout.champion.perTest).toEqual([{ testId: 'hold1', score: 10 }]);

    // Ordering: holdout_result arrives before final finished status
    const hIdx = events.findIndex(e => e.type === 'holdout_result');
    const fIdx = events.findIndex(e => e.type === 'status' && e.status === 'finished');
    expect(hIdx).toBeLessThan(fIdx);
  });

  it('skips holdout with no-champion marker when nothing finished', async () => {
    // Adapter that always throws → all nodes fail → no champion
    registerProvider({ adapter: { name: 'fake', estimateTokens: () => ({ prompt: 1 }),
      call: async () => { throw new Error('always down'); } } as any });
    const events = await runOnce(makeConfig({
      testSet: [
        { id: 'fit1', name: 'f', mode: 'exact_match', prompt: 'X', expected: 'X' },
        { id: 'hold1', name: 'h', mode: 'exact_match', prompt: 'Y', expected: 'Y', holdout: true },
      ],
    }));
    const holdoutEvent = events.find(e => e.type === 'holdout_result');
    expect(holdoutEvent.holdout.skipped).toBe('no-champion');
  });
});
```

(The "never run during generations" property is verified implicitly: with `calls` recording, add `expect(calls.filter(c => c.prompt === 'UNSEEN INPUT' || c.prompt.includes('UNSEEN INPUT')).length).toBe(2 /* seed + champion, samplesPerTest=1 */)` to the first test.)

- [ ] **Step 2: Run to verify failure** — no `holdout_result` event exists.

- [ ] **Step 3: Implement**

In `evaluator_v2.ts`, add above `finishEvaluation`:

```ts
async function runHoldoutEvaluation(runId: UUID, state: EvaluationState): Promise<void> {
  if (state.holdoutTests.length === 0) return;

  const holdout: NonNullable<EvaluationRun['holdout']> = {
    testIds: state.holdoutTests.map(t => t.id),
    samplesPerTest: state.samplesPerTest,
  };
  state.run.holdout = holdout;

  // Champion = best finished node across all generations
  const finished = state.run.generations.flat().filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined);
  const champion = finished.sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!)[0];
  if (!champion) {
    holdout.skipped = 'no-champion';
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }
  if (state.config.targets.budgetUSD && state.run.totals.usd >= state.config.targets.budgetUSD) {
    holdout.skipped = 'budget';
    console.warn('[Evaluator] Budget exhausted — skipping holdout evaluation');
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }

  console.log(`[Evaluator] Holdout: evaluating seed + champion on ${state.holdoutTests.length} unseen test(s)`);
  const score = (rs: TestResult[]) => rs.reduce((a, r) => a + r.score, 0) / rs.length;
  const perTest = (rs: TestResult[]) => rs.map(r => ({ testId: r.testId, score: r.score }));

  try {
    const championResults = await evaluatePromptOnTests(champion.prompt, champion.params, state.holdoutTests, state, runId);
    holdout.champion = { score: score(championResults), perTest: perTest(championResults) };
    const seedResults = await evaluatePromptOnTests(state.config.population.seedPrompt, champion.params, state.holdoutTests, state, runId);
    holdout.seed = { score: score(seedResults), perTest: perTest(seedResults) };
    console.log(`[Evaluator] Generalization (unseen tests): seed ${holdout.seed.score.toFixed(2)} → champion ${holdout.champion.score.toFixed(2)}`);
  } catch (error) {
    console.error('[Evaluator] Holdout evaluation failed:', error);
  }
  sendUpdate(runId, { type: 'holdout_result', holdout });
}
```

Make `finishEvaluation` async and call `await runHoldoutEvaluation(runId, state);` as its FIRST statement (before status flips and the run row persists — the existing `UPDATE evaluation_runs` then stores `run.holdout` automatically). Find every call site with `grep -n "finishEvaluation(" packages/core/src/engine/evaluator_v2.ts` and prepend `await ` (all call sites are inside async functions — verify; if one isn't, chain `.catch(console.error)`).

- [ ] **Step 4: Run tests** — new tests PASS, full suite green, type-check clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/tests/engine/fidelity.test.ts
git commit -m "Holdout end-evaluation: seed vs champion generalization report"
```

---

### Task 5: CLI passthrough, collector, report, docs

**Files:**
- Modify: `packages/cli/src/config.ts` (CliConfig fields + mapping), `packages/cli/src/engine.ts` (collector + EvolutionResult), `packages/cli/src/report.ts` (Generalization section)
- Modify: `docs/cli.md`, `README.md`, `.claude/skills/evolving-prompts/SKILL.md`
- Test: `packages/cli/tests/config.test.ts` (additions)

**Interfaces:**
- Consumes: `holdout_result` event, `EvaluationRun['holdout']` shape.
- Produces: `EvolutionResult.holdout?: EvaluationRun['holdout']` in results.json; stderr line `Generalization (unseen tests): seed <X> → champion <Y>`.

- [ ] **Step 1: Failing config tests** (append to `packages/cli/tests/config.test.ts`, matching its existing style — it builds CliConfig objects and asserts `toEvaluationConfig` output):

```ts
describe('evaluation fidelity fields', () => {
  it('passes promptMode, samplesPerTest, holdoutShare, holdoutSeed through', () => {
    const cfg = toEvaluationConfig({
      seedPrompt: 's', testSet: [{ prompt: 'p' }],
      promptMode: 'inline', samplesPerTest: 3, holdoutShare: 0.25, holdoutSeed: 7,
    } as any, '.');
    expect(cfg.promptMode).toBe('inline');
    expect(cfg.samplesPerTest).toBe(3);
    expect(cfg.holdoutShare).toBe(0.25);
    expect(cfg.holdoutSeed).toBe(7);
  });

  it('passes per-test holdout flags through', () => {
    const cfg = toEvaluationConfig({
      seedPrompt: 's',
      testSet: [{ prompt: 'a' }, { prompt: 'b', holdout: true }],
    } as any, '.');
    expect(cfg.testSet[0].holdout).toBeUndefined();
    expect(cfg.testSet[1].holdout).toBe(true);
  });
});
```

(`toEvaluationConfig` import already present in that file.)

- [ ] **Step 2: Run to verify failure**, then implement:

`config.ts`: `CliConfig` gains `promptMode?: 'system' | 'inline'; samplesPerTest?: number; holdoutShare?: number; holdoutSeed?: number;` and the testSet entry type gains `holdout?: boolean;`. In `toEvaluationConfig`: map the four fields (only when defined: `...(config.promptMode ? { promptMode: config.promptMode } : {})` etc.) and in the testSet mapping include `...(t.holdout ? { holdout: true } : {})`.

`engine.ts`: `EvolutionResult` gains `holdout?: any;` (typed as `EvaluationRun['holdout']` — import the type). In the collector switch add:
```ts
      case 'holdout_result':
        collector.holdout = data.holdout;
        break;
```
(add `holdout: null` to `createCollector`, include `holdout: collector.holdout ?? undefined` in `buildResult`). After the run, in the stderr summary area of `runEvolution` (next to the existing final writes), print when present:
```ts
  if (result.holdout?.seed && result.holdout?.champion) {
    process.stderr.write(`Generalization (unseen tests): seed ${result.holdout.seed.score.toFixed(2)} → champion ${result.holdout.champion.score.toFixed(2)}\n`);
  }
```

`report.ts`: in `generateReport`, after the summary/totals section (locate with `grep -n "Total cost\|## " packages/cli/src/report.ts | head`), insert:
```ts
  if (result.holdout && (result.holdout.seed || result.holdout.champion || result.holdout.skipped)) {
    lines.push('', '## Generalization (holdout tests)', '');
    if (result.holdout.skipped) {
      lines.push(`Holdout evaluation skipped: ${result.holdout.skipped}`);
    } else {
      lines.push(`Seed prompt: **${result.holdout.seed!.score.toFixed(2)}** → Champion: **${result.holdout.champion!.score.toFixed(2)}** (${result.holdout.testIds.length} unseen test(s), ${result.holdout.samplesPerTest} sample(s)/test)`);
    }
  }
```
(adapt `lines.push` to the report builder's actual accumulation style — check how sections are appended and match it.)

- [ ] **Step 3: Docs**

`docs/cli.md` — add after the Plugins section:

```markdown
## Evaluation fidelity

- `"promptMode": "system"` (default) sends the candidate prompt as a real system message and the test prompt as the user message — matching production deployment. `"inline"` restores single-message concatenation (for evolving user-message prompts).
- `"samplesPerTest": 3` runs every test 3× per candidate and scores the mean (`samples` array in results). Damps judge/sampling noise; multiplies evaluation cost. If the candidate has a seed, samples use seed+i; temperature 0 with a fixed seed makes samples redundant.
- Holdout: mark tests `"holdout": true` and/or set `"holdoutShare": 0.3` (+ optional `"holdoutSeed"`) to reserve tests evolution never sees. After the run, the seed prompt AND the champion are scored on them — results.json `holdout` field and the report's "Generalization" section show `seed X → champion Y`. That number is the honest one: it can't be overfit.
```

`README.md` — in "Tests are the spec": add `"holdout": true` to one test in the JSON example plus a bullet: `- **holdout** tests are invisible to evolution; the run ends by scoring both seed and champion on them — a generalization number that can't be overfit. Add \`samplesPerTest\` to average away judge noise.`

`.claude/skills/evolving-prompts/SKILL.md` — in "Getting improvement", add: `- **Trust the holdout number**: mark 1-2 tests "holdout": true (or set holdoutShare) and use samplesPerTest: 2-3 with llm_grade — the final seed→champion score on unseen tests is the claim worth reporting.` (word budget: trim an existing low-value line if needed to stay ~500 words.)

- [ ] **Step 4: Run** — CLI suite + full suite green; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/engine.ts packages/cli/src/report.ts packages/cli/tests/config.test.ts docs/cli.md README.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI + docs: fidelity config passthrough, holdout in results and report"
```

---

### Task 6: Desktop — store event, Footer display, modal inputs

**Files:**
- Modify: `apps/desktop/src/store/evaluationStore.ts` (handle `holdout_result`)
- Modify: `apps/desktop/src/components/Footer.tsx` (holdout line)
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (fidelity inputs + per-test holdout checkbox)
- Test: `apps/desktop/tests/store/evaluationStore.test.ts` (addition)

- [ ] **Step 1: Failing store test** (append to the subscriptions describe):

```ts
  it('holdout_result updates the run', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');
    capturedCallbacks.get('run-1')!({}, {
      type: 'holdout_result',
      holdout: { testIds: ['t9'], samplesPerTest: 1, seed: { score: 5, perTest: [] }, champion: { score: 9, perTest: [] } },
    });
    expect((store().evaluations.get('run-1') as any).holdout.champion.score).toBe(9);
  });
```

- [ ] **Step 2: Implement**

`evaluationStore.ts`: add an action `setHoldout: (evalId, holdout) => void` (same immutable-map update pattern as `updateTotals`, setting `{ ...evaluation, holdout }`), declare it in the interface, and add to the subscribe handler switch:
```ts
        case 'holdout_result':
          store.setHoldout(evalId, data.holdout);
          break;
```

`Footer.tsx`: locate the stats row (`grep -n "Cache Hits" apps/desktop/src/components/Footer.tsx`); after the Cache Hits stat, render conditionally (matching the existing stat markup pattern):
```tsx
{(evaluation as any)?.holdout?.champion && (evaluation as any)?.holdout?.seed && (
  <div>
    <div className="text-xs text-muted-foreground">Holdout</div>
    <div className="font-semibold">
      {(evaluation as any).holdout.seed.score.toFixed(2)} → {(evaluation as any).holdout.champion.score.toFixed(2)}
    </div>
  </div>
)}
```
(Adopt the file's actual stat-item structure; the `as any` casts disappear if `EvaluationRun` from core types is what the component already uses — it is, via `../types` — so use typed access.)

`NewEvaluationModal.tsx`:
1. Test Set tab (`TestSetTab` — find via `grep -n "Add Test" `): in each test row, after the Test Prompt textarea, add a holdout checkbox bound to `test.holdout` (the tab already has an update-test helper; follow its pattern):
```tsx
<label className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
  <input type="checkbox" checked={!!test.holdout}
         onChange={(e) => updateTest(index, { ...test, holdout: e.target.checked || undefined })} />
  Holdout (excluded from evolution; used for the final generalization report)
</label>
```
2. Targets tab (advanced): add three inputs following the existing `LabelWithTooltip` + `Input` pattern — `samplesPerTest` (number 1-10, writes `config.samplesPerTest`), `holdoutShare` (number 0-1 step 0.05), and a `promptMode` select (`system`/`inline`, default system) writing `config.promptMode`. Tooltips: samples "Run each test N times and average the scores — damps judge noise, multiplies cost"; holdoutShare "Fraction of tests reserved for the final generalization report"; promptMode "How the candidate prompt is sent: as a real system message (recommended) or concatenated inline with the test input".

- [ ] **Step 3: Verify** — desktop tests green, `npm run type-check` clean, boot smoke (`npm run build:dev -w apps/desktop`, launch with CDP, open the modal Targets tab and confirm the three inputs render, kill).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/store/evaluationStore.ts apps/desktop/src/components/Footer.tsx apps/desktop/src/components/NewEvaluationModal.tsx apps/desktop/tests/store/evaluationStore.test.ts
git commit -m "Desktop: holdout display, fidelity config inputs"
```

---

### Task 7: Live verification run

**Files:** none committed (scratch config + results only).

- [ ] **Step 1**: In the scratchpad, write a config: `gemini/gemini-2.5-flash-lite` (candidates + service), `promptMode` default (system), `samplesPerTest: 2`, 3 tests with one `"holdout": true`, population 3 / generations 2 / budget 0.02; run via `npm run cli` with `--db` isolation and `--output`.
- [ ] **Step 2**: Assert from the output: run exits 0; stderr shows `Generalization (unseen tests): seed <X> → champion <Y>`; results.json `holdout` has seed+champion with perTest entries; a `tests[].samples` array of length 2 exists on nodes; spot-check one provider request in the verbose log shows `systemInstruction` (Gemini) carrying the candidate prompt.
- [ ] **Step 3**: Report the numbers; if anything mismatches the spec, STOP and fix before closing the phase.
