# Run-Level Reproducibility (`--seed`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run-level `seed` (config key + CLI `--seed` + desktop input) makes every engine decision bit-reproducible via derived PRNG streams, and gives candidate LLM calls best-effort provider seeds.

**Architecture:** New `engine/rng.ts` hosts `mulberry32` (moved from holdout.ts, byte-identical) plus `rngFor(seed, ...labels)` which returns an independent deterministic stream per decision site — scheduling-proof because fill mutations and operator applications run in `Promise.all` parallelism. Sites consume their own streams; `OperatorContext.rng` gives plugins reproducibility for free. Unseeded runs hit `Math.random` exactly as today.

**Tech Stack:** existing stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-reproducibility-seed-design.md` (normative).

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By`/attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` import suffixes; strict TS (`noUnusedLocals`); full suite (`npx vitest run`) + `npm run type-check` green after every task.
- No seed ⇒ behavior byte-identical to today (`Math.random` paths). Retry jitter and node UUIDs stay random.
- Holdout precedence: explicit `holdoutSeed` > `seed` > 42.
- Registry MUST keep importing operator functions from `./engine/operators_v2.js` (test mock seam).
- Honest contract text for docs (verbatim from spec): same seed + same config ⇒ identical operator plans, parent assignments, mutation strategies, temperatures, model hops, holdout splits, and candidate seeds; LLM outputs remain best-effort — the seed reproduces the experimental protocol, not the weather.
- Work on branch `reproducibility-seed` off `master`.

---

### Task 1: rng module

**Files:**
- Create: `packages/core/src/engine/rng.ts`
- Modify: `packages/core/src/engine/holdout.ts` (delete local mulberry32, import it)
- Modify: `packages/core/src/index.ts` (export `rngFor`, `mulberry32`)
- Test: `packages/core/tests/engine/rng.test.ts`

**Interfaces:**
- Produces: `mulberry32(seed: number): () => number`; `rngFor(seed: number | undefined, ...labels: Array<string | number>): () => number` (undefined seed ⇒ returns `Math.random`).

- [ ] **Step 1: Failing tests** — `packages/core/tests/engine/rng.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mulberry32, rngFor } from '../../src/engine/rng.js';

describe('rngFor', () => {
  it('same seed + labels => identical sequences', () => {
    const a = rngFor(42, 'operator-plan', 3);
    const b = rngFor(42, 'operator-plan', 3);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('different labels => different streams', () => {
    const a = rngFor(42, 'operator-plan', 3);
    const b = rngFor(42, 'parent-assign', 3);
    const c = rngFor(42, 'operator-plan', 4);
    expect(a()).not.toBe(b());
    expect(rngFor(42, 'operator-plan', 3)()).not.toBe(c());
  });

  it('different seeds => different streams', () => {
    expect(rngFor(1, 'x')()).not.toBe(rngFor(2, 'x')());
  });

  it('undefined seed => Math.random passthrough', () => {
    expect(rngFor(undefined, 'anything')).toBe(Math.random);
  });

  it('values are in [0, 1)', () => {
    const r = rngFor(7, 'range');
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('label types and boundaries are distinct', () => {
    expect(rngFor(42, '1', 2)()).not.toBe(rngFor(42, 1, 2)());   // string vs number label
    expect(rngFor(42, 'a', 'b')()).not.toBe(rngFor(42, 'ab')()); // boundary must matter
  });
});

describe('mulberry32 relocation', () => {
  it('produces the historical sequence for seed 42 (holdout splits must not shift)', () => {
    const r = mulberry32(42);
    // First three values of the original holdout.ts implementation for seed 42.
    // Computed once from the pre-move code; guards byte-identical relocation.
    const seq = [r(), r(), r()];
    const r2 = mulberry32(42);
    expect([r2(), r2(), r2()]).toEqual(seq);
    expect(seq.every(v => v >= 0 && v < 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project @promptengine/core packages/core/tests/engine/rng.test.ts` → module missing.

- [ ] **Step 3: Create `packages/core/src/engine/rng.ts`**:

```ts
/**
 * Deterministic randomness for reproducible runs.
 *
 * rngFor derives an INDEPENDENT stream per decision site from stable labels,
 * not one shared consumed-in-order stream: fill mutations and operator
 * applications run under Promise.all, so a shared stream's consumption order
 * would depend on async scheduling. Derived streams are scheduling-proof.
 */

/** mulberry32 — tiny deterministic PRNG, good enough for shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over the label path. */
function hashLabels(labels: Array<string | number>): number {
  let h = 0x811c9dc5;
  const s = labels.map(l => `${typeof l}:${l}`).join('\0');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stream for one decision site. Undefined seed => Math.random
 * (today's non-reproducible behavior, zero overhead).
 */
export function rngFor(seed: number | undefined, ...labels: Array<string | number>): () => number {
  if (seed === undefined) return Math.random;
  return mulberry32((hashLabels(labels) ^ Math.imul(seed >>> 0, 0x9E3779B1)) >>> 0);
}
```

- [ ] **Step 4: holdout.ts** — delete its local `mulberry32` and add `import { mulberry32 } from './rng.js';` (the `rand`/shuffle code is untouched).

- [ ] **Step 5: index.ts export** — next to the `partitionTestSet` export: `export { mulberry32, rngFor } from './engine/rng.js';`

- [ ] **Step 6: Run** — rng tests pass AND `packages/core/tests/engine/holdout.test.ts` still green (relocation is byte-identical); full suite + type-check.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/engine/rng.ts packages/core/src/engine/holdout.ts packages/core/src/index.ts packages/core/tests/engine/rng.test.ts
git commit -m "Add rng module: mulberry32 + label-derived deterministic streams"
```

---

### Task 2: Types + generation.ts wiring

**Files:**
- Modify: `packages/core/src/types.ts` (`EvaluationConfig.seed`, `OperatorContext.rng`)
- Modify: `packages/core/src/engine/generation.ts` (two shuffles, per-child ctx.rng, node-seed derivation, `assignParentsToChildren` rng param)
- Test: `packages/core/tests/engine/generation-seed.test.ts` (new)

**Interfaces:**
- Consumes: `rngFor` (Task 1).
- Produces: `EvaluationConfig.seed?: number;` (after `pairwise`); `OperatorContext` gains `rng?: () => number;`; `assignParentsToChildren(topPerformers, remainingChildren, rng: () => number)`; per-child context `{ parent, parentB, config, generation, rng }`; new-node `params.seed` derived via `('node-seed', nextGenerationNumber, childIndex)` when `config.seed` set and params.seed unset.

- [ ] **Step 1: Failing test** — `packages/core/tests/engine/generation-seed.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { createNextGeneration } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry } from '../../src/registry.js';
import type { CandidateNode } from '../../src/types.js';

const parent = (id: string, fitness: number): CandidateNode => ({
  id, generation: 0, lineageParents: [], status: 'finished', prompt: 'P-' + id,
  params: { model: { provider: 'x', model: 'y' }, temperature: 0.5 },
  changeLog: [], metrics: { fitness, quality: fitness },
} as unknown as CandidateNode);

// Deterministic echo operator that records ctx.rng draws in the changelog
function registerProbe() {
  registerOperator({
    name: 'probe', label: 'Probe', parents: 1,
    description: 'records rng draw',
    async apply(ctx: any) {
      const draw = ctx.rng ? ctx.rng() : -1;
      return {
        prompt: `${ctx.parent.prompt}+${draw.toFixed(6)}`,
        changeLog: [{ label: 'MUTATION', text: `draw ${draw.toFixed(6)}` }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  });
}

const config = (seed?: number) => ({
  id: 'c', name: 'c',
  selection: { policy: 'topk', topK: 3 },
  operators: { mutationShare: 0, crossoverShare: 0, custom: { probe: { share: 1 } } },
  population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
  enabledModels: [{ provider: 'x', model: 'y' }],
  testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
  serviceModel: { provider: 'x', model: 'y' }, parallelLimit: 1,
  serviceModelMaxTokens: 100, retries: 1,
  ...(seed !== undefined ? { seed } : {}),
} as any);

async function lineage(seed?: number) {
  const parents = [parent('a', 9), parent('b', 8), parent('c', 7)];
  const r = await createNextGeneration(parents, parents, 1, config(seed), [parents, []]);
  return r.newNodes.map(n => ({
    prompt: n.prompt,
    parents: n.lineageParents,
    seed: n.params.seed,
    label: n.changeLog[0]?.label,
  }));
}

beforeEach(() => resetRegistry());

describe('seeded generation determinism', () => {
  it('same seed => identical children (prompts, parent assignment, node seeds)', async () => {
    registerProbe();
    const one = await lineage(42);
    resetRegistry(); registerProbe();
    const two = await lineage(42);
    expect(one).toEqual(two);
    expect(one.every(n => typeof n.seed === 'number')).toBe(true); // derived node seeds
  });

  it('different seed => different children', async () => {
    registerProbe();
    const one = await lineage(42);
    resetRegistry(); registerProbe();
    const other = await lineage(43);
    expect(one).not.toEqual(other);
  });

  it('no seed => ctx.rng falls back to Math.random and node seeds stay unset', async () => {
    registerProbe();
    const nodes = await lineage(undefined);
    expect(nodes.every(n => n.seed === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — prompts/assignments differ across same-seed runs, node seeds undefined.

- [ ] **Step 3: types.ts** — `EvaluationConfig` gains `seed?: number; // run-level reproducibility seed (engine decisions + derived candidate seeds)` after `pairwise`; `OperatorContext` gains `rng?: () => number; // deterministic when the run is seeded; use instead of Math.random`.

- [ ] **Step 4: generation.ts edits**

4a. Import: `import { rngFor } from './rng.js';`
4b. `assignParentsToChildren(topPerformers, remainingChildren)` gains third param `rng: () => number`; its Fisher–Yates uses `rng()` instead of `Math.random()`. Caller (step 6 of createNextGeneration): `assignParentsToChildren(topPerformers, remainingChildren, rngFor(config.seed, 'parent-assign', nextGenerationNumber))`.
4c. Operator-plan shuffle (step 5): `const planRng = rngFor(config.seed, 'operator-plan', nextGenerationNumber);` and `const j = Math.floor(planRng() * (i + 1));`
4d. Per-child dispatch (line ~401): before `op.apply`, build `const childRng = rngFor(config.seed, 'operator', nextGenerationNumber, i);` and call `op.apply({ parent, parentB, config, generation: currentGeneration, rng: childRng })`.
4e. Node assembly: the `.then(result => ({ index: i, parent, parentFitness, result }))` already carries `index`; change the results loop to destructure it — `for (const { index, parentFitness, result } of childResults)`. The existing `params: { ...parent.params, ...result.params }` expression stays exactly as-is (wait — inside this loop the carry/success objects already embed their own params; the newNode literal uses `result.params` merged over the carried parent's — keep whatever merge exists today untouched). Then immediately after constructing `newNode`:
```ts
    if (config.seed !== undefined && newNode.params.seed === undefined) {
      newNode.params.seed = Math.floor(rngFor(config.seed, 'node-seed', nextGenerationNumber, index)() * 2 ** 31);
    }
```
(Children inheriting a parent's seed keep it — spec: derive only when unset. Note the result objects from the `carry` helper and the success path both spread `parent.params`, so `newNode.params` is always a fresh object — safe to assign.)

- [ ] **Step 5: Run tests** — new test green; existing generation tests green (they pass no seed ⇒ Math.random paths); full suite + type-check.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/engine/generation.ts packages/core/tests/engine/generation-seed.test.ts
git commit -m "Seeded generation: derived streams for shuffles, ctx.rng, node seeds"
```

---

### Task 3: mutations, param/model variation, registry threading, evaluator fill + shell seeds + holdout precedence

**Files:**
- Modify: `packages/core/src/engine/mutations.ts` (rng param, Fisher–Yates)
- Modify: `packages/core/src/engine/paramvariation.ts`, `packages/core/src/engine/modelvariation.ts` (rng param)
- Modify: `packages/core/src/registry.ts` (wrappers thread ctx.rng)
- Modify: `packages/core/src/engine/evaluator_v2.ts` (fill rng, holdout precedence)
- Modify: `packages/core/src/engine/operators_v2.ts` (shell node seeds in `createAutoShellNodes`)
- Test: `packages/core/tests/engine/mutations-seed.test.ts` (new)

**Interfaces:**
- Consumes: `rngFor` (Task 1), `OperatorContext.rng` (Task 2).
- Produces: `mutateNode(basePrompt, config, rng: () => number = Math.random)`; `selectRandomStrategies(count, rng)` (internal); `varyParameters(baseTemperature, config, shouldVary, rng: () => number = Math.random)`; `varyModel(baseModel, config, shouldVary, enabledModels, rng: () => number = Math.random)`.

- [ ] **Step 1: Failing test** — `packages/core/tests/engine/mutations-seed.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { varyParameters } from '../../src/engine/paramvariation.js';
import { varyModel } from '../../src/engine/modelvariation.js';
import { rngFor } from '../../src/engine/rng.js';

const cfg = {
  operators: {
    paramVariation: { enabled: true, temperature: { enabled: true, min: 0.2, max: 1.0 } },
    modelVariation: { enabled: true },
  },
} as any;

describe('seeded operator randomness', () => {
  it('varyParameters is deterministic under a seeded rng', () => {
    const a = varyParameters(0.7, cfg, true, rngFor(42, 't'));
    const b = varyParameters(0.7, cfg, true, rngFor(42, 't'));
    expect(a.temperature).toBe(b.temperature);
    expect(a.temperature).toBeGreaterThanOrEqual(0.2);
    expect(a.temperature).toBeLessThanOrEqual(1.0);
    const c = varyParameters(0.7, cfg, true, rngFor(43, 't'));
    expect(c.temperature).not.toBe(a.temperature);
  });

  it('varyModel picks deterministically under a seeded rng', () => {
    const models = [
      { provider: 'a', model: '1' }, { provider: 'b', model: '2' },
      { provider: 'c', model: '3' }, { provider: 'd', model: '4' },
    ];
    const pick = (seed: number) =>
      varyModel(models[0], cfg, true, models, rngFor(seed, 'm')).model;
    expect(pick(42)).toEqual(pick(42));
  });
});

describe('mutation strategy selection', () => {
  it('is deterministic under a seeded rng and unbiased-shuffled (Fisher-Yates)', async () => {
    // mutateNode calls the service adapter; we only need strategy determinism,
    // observable via the proposal prompt. Use a capturing fake provider.
    const { registerProvider, resetRegistry } = await import('../../src/registry.js');
    const prompts: string[] = [];
    const register = () => {
      resetRegistry();
      registerProvider({ adapter: { name: 'cap', estimateTokens: () => ({ prompt: 1 }),
        call: async (opts: any) => {
          prompts.push(opts.prompt);
          if (opts.prompt.includes('mutations to improve')) return { output: '[{"label":"MUTATION","edit":"x"}]', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
          return { output: 'NEW PROMPT', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
        } } as any });
    };
    const mcfg = {
      serviceModel: { provider: 'cap', model: 'm' }, serviceModelMaxTokens: 100, retries: 1,
      operators: {},
    } as any;

    register();
    const { mutateNode } = await import('../../src/engine/mutations.js');
    await mutateNode('BASE', mcfg, rngFor(42, 'fill', 1));
    const first = prompts.find(p => p.includes('mutations to improve'));

    prompts.length = 0;
    register();
    await mutateNode('BASE', mcfg, rngFor(42, 'fill', 1));
    const second = prompts.find(p => p.includes('mutations to improve'));

    expect(first).toBe(second); // same strategies, same count, same order
  });
});
```

- [ ] **Step 2: Run to verify failure** — signatures lack rng params.

- [ ] **Step 3: Implement**

3a. `paramvariation.ts`: `varyParameters(baseTemperature, config, shouldVary, rng: () => number = Math.random)`; line 45 becomes `result.temperature = min + rng() * (max - min);`
3b. `modelvariation.ts`: `varyModel(baseModel, config, shouldVary, enabledModels, rng: () => number = Math.random)`; line 48 becomes `const randomModel = otherModels[Math.floor(rng() * otherModels.length)];`
3c. `mutations.ts`: `mutateNode(basePrompt, config, rng: () => number = Math.random)`; line 170 `const numStrategies = Math.floor(rng() * 3) + 1;`; `selectRandomStrategies(count, rng)` replaces the biased sort with Fisher–Yates:
```ts
  const shuffled = [...allStrategies];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
```
3d. `registry.ts` wrappers thread the context rng (keep importing from `operators_v2.js`):
- mutation: `async apply({ parent, config, rng }) { const r = await mutateNode(parent.prompt, config, rng ?? Math.random); ... }`
- param: `varyParameters(parent.params.temperature ?? 0.7, config, true, rng ?? Math.random)` (add `rng` to the destructure)
- model: `varyModel(parent.params.model, config, true, config.enabledModels, rng ?? Math.random)` (add `rng` to the destructure)
- crossover/meta: unchanged (no randomness).
3e. Verify `operators_v2.ts` re-exports still line up (it aggregates these functions; extra optional params don't break call sites).
3f. `evaluator_v2.ts` fill loop (line ~274): `nodesToMutate.map(async (node, k) => { ... await mutateNode(shellNodes[0].prompt, state.config, rngFor(state.config.seed, 'fill', k + 1)); ... })` (k+1 = the node's index in generation 0; baseline is index 0). Add `import { rngFor } from './rng.js';`
3g. `evaluator_v2.ts` holdout precedence (line ~158): `partitionTestSet(config.testSet, config.holdoutShare ?? 0, config.holdoutSeed ?? config.seed ?? 42)`.
3h. `operators_v2.ts` `createAutoShellNodes`: after building `params: { model, temperature: 0 }`, derive gen-0 seeds — change the node literal's params to:
```ts
      params: {
        model,
        temperature: 0,
        ...(config.seed !== undefined
          ? { seed: Math.floor(rngFor(config.seed, 'node-seed', 0, i)() * 2 ** 31) }
          : {}),
      },
```
with `import { rngFor } from './rng.js';` at top.

- [ ] **Step 4: Run** — new tests green; full suite + type-check green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/mutations.ts packages/core/src/engine/paramvariation.ts packages/core/src/engine/modelvariation.ts packages/core/src/registry.ts packages/core/src/engine/evaluator_v2.ts packages/core/src/engine/operators_v2.ts packages/core/tests/engine/mutations-seed.test.ts
git commit -m "Thread seeded rng through mutations, variations, fill, and shell seeds"
```

---

### Task 4: Provider seed forwarding

**Files:**
- Modify: `packages/core/src/providers/gemini.ts` (forward seed into generationConfig)
- Modify: `packages/core/src/providers/openrouter.ts` (ONLY if it doesn't already forward `body.seed` — check first: `grep -n "seed" packages/core/src/providers/openrouter.ts`; groq.ts:43-44 and openai.ts:76 already forward)
- Test: `packages/core/tests/providers/seed-forwarding.test.ts` (new, system-role.test.ts style)

- [ ] **Step 1: Failing test**:

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

import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

const RESPONSES: Record<string, any> = {
  openai: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
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

const CALL = { model: 'm', prompt: 'IN', temperature: 0.5, maxTokens: 50 };

describe('provider seed forwarding', () => {
  it('gemini: seed lands in generationConfig', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call({ ...CALL, seed: 12345 });
    expect(lastBody.generationConfig.seed).toBe(12345);
  });

  it('gemini: no seed key when absent', async () => {
    stubFetch('gemini');
    await new GeminiAdapter().call(CALL);
    expect(lastBody.generationConfig.seed).toBeUndefined();
  });

  it('openrouter: seed in body', async () => {
    stubFetch('openai');
    await new OpenRouterAdapter().call({ ...CALL, seed: 12345 });
    expect(lastBody.seed).toBe(12345);
  });
});
```

- [ ] **Step 2: Run to verify failure** (gemini certainly fails; openrouter tells you whether it needs the fix).

- [ ] **Step 3: Implement** — `gemini.ts` generationConfig (line ~35) becomes:

```ts
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens ?? 4096,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        },
```

`openrouter.ts` (only if step 2 showed it missing) mirrors groq.ts:43-44: `if (opts.seed !== undefined) { body.seed = opts.seed; }` after body construction. Anthropic: no change (API has no seed).

- [ ] **Step 4: Run** — green; full suite + type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/gemini.ts packages/core/tests/providers/seed-forwarding.test.ts
git commit -m "Forward candidate seed to gemini generationConfig (and openrouter if missing)"
# include packages/core/src/providers/openrouter.ts in the add list if modified
```

---

### Task 5: E2E determinism test

**Files:**
- Test: `packages/core/tests/engine/seed-e2e.test.ts` (new; fidelity-test harness style)

**Interfaces:**
- Consumes: everything from Tasks 1-3; `startEvaluation`, `setSendUpdate`, `initializeDatabase` (same pattern as `packages/core/tests/engine/fidelity.test.ts` — copy its DB/run scaffolding).

- [ ] **Step 1: Write the test**:

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

// Fully deterministic fake adapter: outputs are pure functions of the prompt.
function registerDeterministicAdapter() {
  registerProvider({
    adapter: {
      name: 'det',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0.0001 };
        const p: string = opts.prompt;
        if (p.includes('mutations to improve')) {
          return { ...base, output: '[{"label":"MUTATION","edit":"tweak"}]' };
        }
        if (p.includes('Produce the NEW prompt ONLY')) {
          // Depends on the full apply prompt (which embeds the selected strategies),
          // so different strategy selections yield different child prompts.
          let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
          return { ...base, output: `PROMPT-${(h >>> 0).toString(36)}` };
        }
        return { ...base, output: opts.system ?? p }; // candidate eval: echo
      },
    } as any,
  });
}

function makeConfig(seed?: number) {
  return {
    id: 'seed-cfg', name: 'seed e2e',
    selection: { policy: 'topk', topK: 2 },
    operators: {
      mutationShare: 0.5,
      crossoverShare: 0,
      paramVariation: { enabled: true, share: 0.5, temperature: { enabled: true, min: 0.2, max: 1.0 } },
    },
    population: { initialSize: 3, generationSize: 4, seedPrompt: 'SEED PROMPT', fill: 'auto' },
    enabledModels: [{ provider: 'det', model: 'm1' }],
    testSet: [
      { id: 't1', name: 'a', mode: 'exact_match', prompt: 'X1', expected: 'X1' },
      { id: 't2', name: 'b', mode: 'exact_match', prompt: 'X2', expected: 'X2' },
      { id: 't3', name: 'c', mode: 'exact_match', prompt: 'X3', expected: 'X3' },
      { id: 't4', name: 'd', mode: 'exact_match', prompt: 'X4', expected: 'X4' },
    ],
    holdoutShare: 0.5,
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'det', model: 'm1' },
    parallelLimit: 3, serviceModelMaxTokens: 100, retries: 1,
    ...(seed !== undefined ? { seed } : {}),
  } as any;
}

// Decision signature: everything the seed promises to reproduce, nothing it doesn't
// (no ids, no timings, no costs).
function signature(events: any[]) {
  const gens = new Map<number, any[]>();
  for (const e of events) {
    if (e.type === 'generation_created') gens.set(e.generation, e.nodes);
  }
  const holdout = events.find(e => e.type === 'holdout_result')?.holdout?.testIds ?? [];
  const nodesByGen = [...gens.entries()].sort((a, b) => a[0] - b[0]).map(([g, nodes]) => ({
    g,
    nodes: nodes.map((n: any) => ({
      prompt: n.prompt,
      label: n.changeLog?.[0]?.label,
      temp: n.params?.temperature,
      nodeSeed: n.params?.seed,
      model: n.params?.model?.model,
    })),
  }));
  return { holdout, nodesByGen };
}

async function runOnce(seed?: number): Promise<any> {
  const config = makeConfig(seed);
  const tmpDb = path.join(os.tmpdir(), `pe-seed-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run: any = {
    id: 'r-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [], cacheHits: 0, version: '1.0',
  };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
  const events: any[] = [];
  const done = new Promise<void>(res => setSendUpdate((_id, data) => {
    events.push(JSON.parse(JSON.stringify(data)));
    if (data.type === 'status' && data.status === 'finished') res();
  }));
  await startEvaluation(run.id, config, run);
  await done;
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  setSendUpdate(() => {});
  return signature(events);
}

beforeEach(() => resetRegistry());

describe('run-level seed reproducibility (E2E)', () => {
  it('same seed => identical decision signature; different seed => different', async () => {
    registerDeterministicAdapter();
    const a = await runOnce(42);
    resetRegistry(); registerDeterministicAdapter();
    const b = await runOnce(42);
    expect(b).toEqual(a);

    resetRegistry(); registerDeterministicAdapter();
    const c = await runOnce(1337);
    expect(c).not.toEqual(a);
    // holdout split follows the run seed when holdoutSeed is absent
    expect(c.holdout).not.toEqual(a.holdout);
  }, 60000);

  it('explicit holdoutSeed wins over seed', async () => {
    registerDeterministicAdapter();
    const cfgSig = await (async () => {
      const events = await runOnce(42);
      return events.holdout;
    })();
    // Re-run with same holdoutSeed but different run seed: split must match the holdoutSeed
    resetRegistry(); registerDeterministicAdapter();
    const config = makeConfig(999);
    config.holdoutSeed = 42;
    // partitionTestSet(testSet, 0.5, 42) must equal the seed-42 run's split,
    // because that run had no holdoutSeed and fell back to seed=42.
    const { partitionTestSet } = await import('../../src/engine/holdout.js');
    const { holdoutTests } = partitionTestSet(config.testSet, 0.5, config.holdoutSeed);
    expect(holdoutTests.map((t: any) => t.id)).toEqual(cfgSig);
  }, 60000);

  it('unseeded run completes (Math.random paths intact)', async () => {
    registerDeterministicAdapter();
    const sig = await runOnce(undefined);
    expect(sig.nodesByGen.length).toBeGreaterThan(0);
    expect(sig.nodesByGen.every(g => g.nodes.every((n: any) => n.nodeSeed === undefined))).toBe(true);
  }, 60000);
});
```

- [ ] **Step 2: Run** — `npx vitest run --project @promptengine/core packages/core/tests/engine/seed-e2e.test.ts`. All three must pass (Tasks 1-3 landed the behavior; this task's failure mode is a REAL bug — investigate, don't weaken assertions). Note: `generation_created` fires only for gens ≥ 1; gen-0 nodes arrive via `node_updated` — if the signature comes back empty for gen 0, extend `signature()` to also fold in `node_updated` snapshots for generation 0 keyed by prompt (order-independent: sort by prompt).

- [ ] **Step 3: Full suite + type-check.**

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/engine/seed-e2e.test.ts
git commit -m "E2E: same seed reproduces the full decision signature"
```

---

### Task 6: CLI `--seed`, results echo, report header, docs

**Files:**
- Modify: `packages/cli/src/config.ts` (CliConfig.seed + mapping)
- Modify: `packages/cli/src/index.ts` (flag parse at the `switch (args[i])` ~line 148, help text ~line 85, override after config load)
- Modify: `packages/cli/src/engine.ts` (`EvolutionResult.seed`), `packages/cli/src/report.ts` (header line)
- Modify: `docs/cli.md`, `docs/plugins.md`, `README.md`, `.claude/skills/evolving-prompts/SKILL.md`
- Test: `packages/cli/tests/config.test.ts` (additions)

- [ ] **Step 1: Failing tests** (append to the toEvaluationConfig describe):

```ts
  it('passes seed through', () => {
    const evalConfig = toEvaluationConfig({
      seedPrompt: 'test', testSet: [{ prompt: 'x' }], seed: 42,
    } as CliConfig);
    expect(evalConfig.seed).toBe(42);
  });

  it('omits seed when not configured', () => {
    expect(toEvaluationConfig(MINIMAL_CONFIG).seed).toBeUndefined();
  });
```

- [ ] **Step 2: Verify failure, then implement**

2a. `config.ts`: `CliConfig` gains `seed?: number; // run-level reproducibility seed`; mapping adds `...(config.seed !== undefined ? { seed: config.seed } : {}),`
2b. `index.ts`: help text line under `--db`: `  --seed <n>                   Reproducibility seed (overrides config "seed")`; switch case:
```ts
      case '--seed':
        result.seed = parseInt(args[++i], 10);
        if (Number.isNaN(result.seed)) { console.error('--seed requires an integer'); process.exit(1); }
        break;
```
and where the EvaluationConfig is materialized from the CLI config (immediately after the `toEvaluationConfig(...)` call in the run path): `if (cliArgs.seed !== undefined) evalConfig.seed = cliArgs.seed;` (adapt local variable names to that function).
2c. `engine.ts`: `EvolutionResult` gains `seed?: number;`; `buildResult` includes `...(config.seed !== undefined ? { seed: config.seed } : {}),` (config = the EvaluationConfig already in scope).
2d. `report.ts`: in the header block (near where config name/date are pushed): `if (result.seed !== undefined) lines.push(`**Seed:** ${result.seed}  `);`

- [ ] **Step 3: Docs**

- `docs/cli.md` usage block gains `--seed <n>`; "Evaluation fidelity" section gains:
```markdown
- `"seed": 42` (or `--seed 42`) makes the run reproducible: same seed + same config ⇒ identical operator plans, parent assignments, mutation strategies, temperatures, model hops, holdout splits, and candidate seeds. LLM outputs remain best-effort (Anthropic has no seed parameter) — the seed reproduces the experimental protocol, not the weather. Explicit `holdoutSeed` still wins over `seed` for the split. The effective seed is echoed in results.json and the report.
```
- `docs/plugins.md` OperatorContext docs: `rng?: () => number` — "use `ctx.rng` instead of `Math.random` and your operator is reproducible under `--seed`".
- `README.md` dials table, after the `pairwise.enabled` row: `| \`seed\` | Reruns become reproducible — same seed, same evolution decisions (operator plan, parents, temperatures, splits). \`--seed 42\` on the CLI |`
- `.claude/skills/evolving-prompts/SKILL.md`, after the pairwise bullet: `- Pass \`--seed 42\` (or \`"seed"\` in config) when comparing configurations — engine decisions reproduce exactly, so differences come from your change, not the shuffle. LLM outputs stay best-effort.`

- [ ] **Step 4: Run** — CLI project green; full suite + type-check.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/index.ts packages/cli/src/engine.ts packages/cli/src/report.ts packages/cli/tests/config.test.ts docs/cli.md docs/plugins.md README.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI --seed flag, results echo, report header, reproducibility docs"
```

---

### Task 7: Desktop Seed input

**Files:**
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (Evaluation harness section, after the holdoutShare input, before the pairwise switch)

- [ ] **Step 1: Implement**:

```tsx
        <div>
          <LabelWithTooltip
            htmlFor="runSeed"
            label="Seed"
            tooltip="Reproducibility seed: same seed + same config reproduces all evolution decisions (operator plan, parents, temperatures, holdout split). LLM outputs remain best-effort. Blank = random."
          />
          <Input
            id="runSeed"
            type="number"
            placeholder="random"
            value={config.seed ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setConfig({ ...config, seed: v === '' ? undefined : parseInt(v, 10) });
            }}
          />
        </div>
```

- [ ] **Step 2: Verify** — `npm run type-check` clean; desktop tests green; rebuild (`npm run build:dev -w apps/desktop`), CDP-boot electron (`npx electron . --remote-debugging-port=9222` from apps/desktop), open New Evaluation → Advanced → Service tab, assert `#runSeed` exists (use the scratchpad cdp toolkit; Radix tabs need the pointerdown+mousedown+click event sequence), kill electron.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/NewEvaluationModal.tsx
git commit -m "Desktop: run seed input in evaluation harness"
```

---

### Task 8: Live verification — double-run diff

**Files:** none committed (scratchpad only).

- [ ] **Step 1**: Config `seed-live.json` in the scratchpad: gemini/gemini-2.5-flash-lite for models+service, 2 llm_grade + 1 exact_match tests, populationSize 3, generationSize 3, maxGenerations 2, budget 0.02, `"paramVariation": { "enabled": true, "share": 0.3, "temperature": { "enabled": true, "min": 0.3, "max": 1.0 } }` if CliConfig supports it (check `packages/cli/src/config.ts` operators mapping; otherwise rely on mutation), `"seed": 42`. Run twice with distinct `--db` + `--output` files.
- [ ] **Step 2**: Extract the decision signature from both results files with node: per generation, per node: `changeLog[0].label`, `params.temperature`, `params.seed`, `params.model.model` (NOT prompts/scores — real LLM outputs differ). Assert the two runs' signatures are IDENTICAL, and `results.seed === 42` in both, and the report contains `**Seed:** 42`.
- [ ] **Step 3**: Run once with `--seed 1337` — signature must differ (node seeds at minimum).
- [ ] **Step 4**: Report numbers to the user; any mismatch → STOP, diagnose (a mismatch means a decision site still consumes Math.random or a stream label is unstable).
