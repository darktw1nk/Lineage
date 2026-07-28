# Plugin System Implementation Plan (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File-based plugin system: community operators and providers load from plugin directories in both hosts (CLI + Electron), with the five built-in operators converted to registry entries behind one dispatch mechanism.

**Architecture:** A registry module in `@promptengine/core` holds `OperatorPlugin`/`ProviderPlugin` entries (built-ins pre-registered); `generation.ts`'s hardcoded 5-way switch becomes a generic shares-map + registry dispatch; a loader dynamic-imports validated JS modules and returns manifests; hosts wire discovery (CLI: config `plugins` + `--plugins`; desktop: `userData/plugins` + enable/disable persisted in the store) and the desktop gets a minimal Settings panel + dynamic plugin-operator sliders.

**Tech Stack:** TypeScript 5.3 strict ESM, dynamic `import()` + `pathToFileURL`, Vitest 4, existing sql.js persistence, Electron IPC + React (shadcn/ui) for the panel.

**Spec:** `docs/superpowers/specs/2026-07-28-plugin-system-design.md` — normative for any detail not repeated here.

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By` or any attribution trailer.
- Never `git add -A` / `git add .` — stage exact paths only (repo has untracked local dirs: `experiments/`, `.idea/`).
- ESM everywhere; relative import specifiers keep the `.js` extension (also when importing `.ts` files).
- `packages/core` must never import `electron` or `electron-store`.
- Consumers import ONLY from `@promptengine/core`'s index; every new public symbol added there.
- TypeScript strict incl. `noUnusedLocals`/`noUnusedParameters`; after every task: relevant tests green AND `npm run type-check` clean.
- All commands below run from repo root `D:\projects\evolution2` (Bash tool).
- Existing behavior contracts to preserve: legacy operator config fields keep working unchanged; operator failure → carry-forward node with `ERROR` changelog; elitism/parent-assignment logic untouched.

---

### Task 1: Core types, registry with built-in operators, provider fallback

**Files:**
- Modify: `packages/core/src/types.ts` (open unions, new interfaces, `operators.custom`)
- Create: `packages/core/src/registry.ts`
- Modify: `packages/core/src/providers/index.ts` (registry fallback + throw)
- Modify: `packages/core/src/database/init.ts` (flush queued plugin models at end of `initializeDatabase`)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/tests/registry.test.ts`

**Interfaces:**
- Consumes: existing `mutateNode(prompt, config)`, `crossoverNodes(a, b, config)`, `metaPromptNode(parent, config, generation)`, `varyParameters(temp, config, force)` → `{ temperature, changeLog }`, `varyModel(model, config, force, enabledModels)` → `{ model, changeLog }`.
- Produces (later tasks rely on exactly these):
  - Types `OperatorContext`, `OperatorResult`, `OperatorPlugin`, `ProviderPlugin`, `PluginManifest` exactly as in the spec's "New core types" section.
  - `Provider` = `'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | (string & {})`; `ChangeLabel` = existing literals `| (string & {})`.
  - `EvaluationConfig['operators']` gains `custom?: Record<string, { enabled?: boolean; share: number }>`.
  - `registry.ts` exports: `registerOperator(op: OperatorPlugin): void`, `registerProvider(plugin: ProviderPlugin): void`, `getOperator(name: string): OperatorPlugin | undefined`, `listOperators(): OperatorPlugin[]`, `listProviders(): string[]`, `getRegisteredProviderAdapter(id: string): ProviderAdapter | undefined`, `flushPendingPluginModels(db: SqlJsWrapper): void`, `resetRegistry(): void`, `BUILTIN_OPERATOR_NAMES: readonly string[]`.
  - `getProviderAdapter(provider)` throws `Error('Unknown provider: <id>')` for unregistered ids.
  - Core index additionally exports `BaseProviderAdapter` (plugins subclass it for retry/semaphore/key handling).

- [ ] **Step 1: Write the failing tests** — `packages/core/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import {
  registerOperator, registerProvider, getOperator, listOperators, listProviders,
  resetRegistry, BUILTIN_OPERATOR_NAMES,
} from '../src/registry.js';
import { getProviderAdapter } from '../src/providers/index.js';
import type { OperatorPlugin, ProviderAdapter } from '../src/types.js';

const fakeOp = (name: string): OperatorPlugin => ({
  name, parents: 1,
  apply: async ({ parent }) => ({
    prompt: parent.prompt + '!', changeLog: [{ label: 'FAKE', text: 'x' }],
    cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
  }),
});

const fakeAdapter = (name: string): ProviderAdapter => ({
  name: name as any,
  estimateTokens: () => ({ prompt: 1 }),
  call: async () => ({ output: 'ok', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
});

beforeEach(() => resetRegistry());

describe('operator registry', () => {
  it('pre-registers the five built-ins', () => {
    expect(BUILTIN_OPERATOR_NAMES).toEqual(['mutation', 'crossover', 'meta', 'param', 'model']);
    for (const n of BUILTIN_OPERATOR_NAMES) expect(getOperator(n)).toBeDefined();
    expect(getOperator('crossover')!.parents).toBe(2);
  });

  it('registers and lists plugin operators', () => {
    registerOperator(fakeOp('section-shuffle'));
    expect(getOperator('section-shuffle')!.name).toBe('section-shuffle');
    expect(listOperators().map(o => o.name)).toContain('section-shuffle');
  });

  it('throws on duplicate operator names, including built-ins', () => {
    registerOperator(fakeOp('dup'));
    expect(() => registerOperator(fakeOp('dup'))).toThrow(/already registered/);
    expect(() => registerOperator(fakeOp('mutation'))).toThrow(/already registered/);
  });

  it('resetRegistry clears plugins but keeps built-ins', () => {
    registerOperator(fakeOp('temp-op'));
    resetRegistry();
    expect(getOperator('temp-op')).toBeUndefined();
    expect(getOperator('mutation')).toBeDefined();
  });
});

describe('provider registry', () => {
  it('getProviderAdapter falls back to registered plugin providers', () => {
    registerProvider({ adapter: fakeAdapter('ollama') });
    expect(getProviderAdapter('ollama').name).toBe('ollama');
    expect(listProviders()).toContain('ollama');
  });

  it('built-ins win and cannot be shadowed', () => {
    expect(() => registerProvider({ adapter: fakeAdapter('openai') })).toThrow(/already registered/);
    expect(getProviderAdapter('openai').name).toBe('openai');
  });

  it('throws a clear error for unknown providers', () => {
    expect(() => getProviderAdapter('nope')).toThrow(/Unknown provider: nope/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @promptengine/core packages/core/tests/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 3: Add types to `packages/core/src/types.ts`**

Change the two unions:

```ts
export type Provider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | (string & {});
export type ChangeLabel = 'MUTATION' | 'CROSSOVER' | 'META' | 'PARAM' | 'MODEL' | 'ELITE' | 'CARRY' | 'ERROR' | (string & {});
```

Add after `ModelCostEntry` (interfaces exactly as in the spec's "New core types" section): `OperatorContext`, `OperatorResult`, `OperatorPlugin`, `ProviderPlugin`, `PluginManifest`.

In `EvaluationConfig.operators`, after `paramVariation`, add:

```ts
    custom?: Record<string, { enabled?: boolean; share: number }>; // plugin operator shares, keyed by operator name
```

- [ ] **Step 4: Create `packages/core/src/registry.ts`**

```ts
/**
 * Operator & provider registries. Built-in operators are pre-registered here
 * as thin wrappers around the existing operator modules; plugins add entries
 * via registerOperator/registerProvider (usually through the plugin loader).
 *
 * Import-cycle note: this module imports operator functions whose modules
 * import providers/index.js, which imports this module back. That is safe
 * because every cross-module reference happens at call time, never during
 * module initialization.
 */
import type { OperatorPlugin, ProviderPlugin, ProviderAdapter, ModelCostEntry } from './types.js';
import type { SqlJsWrapper } from './database/init.js';
import { mutateNode, crossoverNodes, metaPromptNode } from './engine/operators_v2.js';
import { varyParameters } from './engine/paramvariation.js';
import { varyModel } from './engine/modelvariation.js';

const ZERO_COST = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 };
const BUILTIN_PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq'];
export const BUILTIN_OPERATOR_NAMES = ['mutation', 'crossover', 'meta', 'param', 'model'] as const;

const operators = new Map<string, OperatorPlugin>();
const providers = new Map<string, ProviderAdapter>();
let pendingModels: ModelCostEntry[] = [];

function builtinOperators(): OperatorPlugin[] {
  return [
    {
      name: 'mutation', label: 'Mutation', parents: 1,
      description: 'Strategy-guided LLM rewrite of the prompt',
      async apply({ parent, config }) {
        const r = await mutateNode(parent.prompt, config);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'crossover', label: 'Crossover', parents: 2,
      description: 'LLM merge of two parent prompts',
      async apply({ parent, parentB, config }) {
        const r = await crossoverNodes(parent, parentB!, config);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'meta', label: 'Meta-prompting', parents: 1,
      description: 'Failure-aware surgical edits from test results',
      async apply({ parent, config, generation }) {
        const r = await metaPromptNode(parent, config, generation);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'param', label: 'Param variation', parents: 1,
      description: 'Temperature/seed variation, prompt unchanged',
      async apply({ parent, config }) {
        const v = varyParameters(parent.params.temperature ?? 0.7, config, true);
        return { prompt: parent.prompt, params: { temperature: v.temperature }, changeLog: v.changeLog, cost: ZERO_COST };
      },
    },
    {
      name: 'model', label: 'Model variation', parents: 1,
      description: 'Same prompt on a different enabled model',
      async apply({ parent, config }) {
        const v = varyModel(parent.params.model, config, true, config.enabledModels);
        if (v.changeLog.length === 0) {
          return {
            prompt: parent.prompt,
            changeLog: [{ label: 'CARRY', text: 'Model variation skipped (no other models available)' }],
            cost: ZERO_COST,
          };
        }
        return { prompt: parent.prompt, params: { model: v.model }, changeLog: v.changeLog, cost: ZERO_COST };
      },
    },
  ];
}

function registerBuiltins(): void {
  for (const op of builtinOperators()) operators.set(op.name, op);
}
registerBuiltins();

export function registerOperator(op: OperatorPlugin): void {
  if (operators.has(op.name)) {
    throw new Error(`Operator '${op.name}' is already registered`);
  }
  operators.set(op.name, op);
}

export function getOperator(name: string): OperatorPlugin | undefined {
  return operators.get(name);
}

export function listOperators(): OperatorPlugin[] {
  return [...operators.values()];
}

export function registerProvider(plugin: ProviderPlugin): void {
  const id = plugin.adapter.name;
  if (BUILTIN_PROVIDER_IDS.includes(id) || providers.has(id)) {
    throw new Error(`Provider '${id}' is already registered`);
  }
  providers.set(id, plugin.adapter);
  if (plugin.models?.length) {
    pendingModels.push(...plugin.models);
    tryFlushModels();
  }
}

export function getRegisteredProviderAdapter(id: string): ProviderAdapter | undefined {
  return providers.get(id);
}

export function listProviders(): string[] {
  return [...BUILTIN_PROVIDER_IDS, ...providers.keys()];
}

/** Upsert queued plugin model costs; safe to call when the db is unavailable. */
export function flushPendingPluginModels(db: SqlJsWrapper): void {
  if (pendingModels.length === 0) return;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);
  for (const m of pendingModels) {
    // Plugin entries are already per-1k (unlike the seeded defaults, which are
    // authored per-million and divided at insert) — pass through unchanged.
    insert.run(m.provider, m.model, m.promptUSDper1k, m.completionUSDper1k);
  }
  pendingModels = [];
}

function tryFlushModels(): void {
  // getDatabase throws before initializeDatabase — swallow and let
  // initializeDatabase flush the queue later.
  import('./database/init.js').then(({ getDatabase }) => {
    try { flushPendingPluginModels(getDatabase()); } catch { /* not initialized yet */ }
  }).catch(() => { /* ignore */ });
}

/** Test helper: clears plugin registrations, keeps built-ins. */
export function resetRegistry(): void {
  operators.clear();
  providers.clear();
  pendingModels = [];
  registerBuiltins();
}
```

- [ ] **Step 5: Provider factory fallback** — `packages/core/src/providers/index.ts`, replace `getProviderAdapter`:

```ts
import { getRegisteredProviderAdapter } from '../registry.js';

export function getProviderAdapter(provider: Provider): ProviderAdapter {
  const builtin = adapters[provider as keyof typeof adapters];
  if (builtin) return builtin;
  const plugin = getRegisteredProviderAdapter(provider);
  if (plugin) return plugin;
  throw new Error(`Unknown provider: ${provider}`);
}
```

(The `adapters` map declaration changes from `Record<Provider, ProviderAdapter>` to a plain object literal typed `Record<string, ProviderAdapter>` so the opened union doesn't demand an index signature for arbitrary strings.)

- [ ] **Step 6: Flush hook in `initializeDatabase`** — `packages/core/src/database/init.ts`, at the end of `initializeDatabase` after `runMigrations(db)`:

```ts
  // Plugin providers registered before the database opened queued their
  // model catalog entries — flush them now.
  const { flushPendingPluginModels } = await import('../registry.js');
  flushPendingPluginModels(db);
```

(Dynamic import avoids a static cycle registry → database/init → registry.)

- [ ] **Step 7: Core index exports** — `packages/core/src/index.ts`, add:

```ts
export {
  registerOperator, registerProvider, getOperator, listOperators, listProviders,
  resetRegistry, flushPendingPluginModels, BUILTIN_OPERATOR_NAMES,
} from './registry.js';
export { BaseProviderAdapter } from './providers/base.js';
export type {
  OperatorContext, OperatorResult, OperatorPlugin, ProviderPlugin, PluginManifest,
} from './types.js';
```

(Verify `providers/base.ts` exports the class with that exact name — it does: `abstract class BaseProviderAdapter`; ensure it has `export`.)

- [ ] **Step 8: Run tests + type-check**

Run: `npx vitest run --project @promptengine/core packages/core/tests/registry.test.ts` → PASS (all cases)
Run: `npx vitest run` → all suites green (dispatch untouched so far)
Run: `npm run type-check` → clean

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/registry.ts packages/core/src/providers/index.ts packages/core/src/database/init.ts packages/core/src/index.ts packages/core/tests/registry.test.ts
git commit -m "Add operator/provider registries with built-in operators as entries"
```

---

### Task 2: Generalized dispatch + effectiveness tracking

**Files:**
- Modify: `packages/core/src/engine/generation.ts:286-532` (shares collection through child-creation loop)
- Modify: `packages/core/src/engine/evaluator_v2.ts` (`operatorEffectiveness` shape + tracking block)
- Test: `packages/core/tests/engine/plugin-dispatch.test.ts` (new)

**Interfaces:**
- Consumes: `getOperator(name)`, `registerOperator`, `resetRegistry`, `OperatorContext`/`OperatorResult` from Task 1.
- Produces: `createNextGeneration` honors `config.operators.custom` (spec precedence: `custom` entries override legacy fields for the same name; `enabled === false` → share 0; unknown names warned + dropped); `_operatorType` on new nodes is the operator name string; `EvaluationState['operatorEffectiveness']` is `Record<string, { totalDelta: number; count: number }>`.

- [ ] **Step 1: Write the failing test** — `packages/core/tests/engine/plugin-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));
// Mutation/crossover/meta call LLMs — stub the provider factory so built-ins
// selected by leftover shares can't make network calls in this test.
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai',
    estimateTokens: () => ({ prompt: 1 }),
    call: async () => ({ output: 'stub', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
  }),
}));

import { createNextGeneration } from '../../src/engine/generation.js';
import { registerOperator, resetRegistry } from '../../src/registry.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

function makeParent(id: string, fitness = 5): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished',
    prompt: `prompt-${id}`,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness, quality: fitness },
  } as CandidateNode;
}

function makeConfig(custom: NonNullable<EvaluationConfig['operators']['custom']>): EvaluationConfig {
  return {
    id: 'c1', name: 'dispatch test',
    selection: { policy: 'topk', topK: 2 },
    operators: { mutationShare: 0, crossoverShare: 0, custom },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
    testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
    serviceModel: { provider: 'openai', model: 'gpt-x' },
    parallelLimit: 2, serviceModelMaxTokens: 100, retries: 1,
  } as EvaluationConfig;
}

beforeEach(() => resetRegistry());

describe('plugin operator dispatch', () => {
  it('routes children through a registered plugin operator', async () => {
    const seen: string[] = [];
    registerOperator({
      name: 'upper', parents: 1,
      apply: async ({ parent }) => {
        seen.push(parent.id);
        return {
          prompt: parent.prompt.toUpperCase(),
          changeLog: [{ label: 'UPPER', text: 'uppercased' }],
          cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 1 },
        };
      },
    });

    const parents = [makeParent('p1'), makeParent('p2')];
    const { newNodes, costTracking } = await createNextGeneration(
      parents, makeConfig({ upper: { share: 1 } }), 1, parents,
    );

    const children = newNodes.filter(n => (n as any)._operatorType === 'upper');
    expect(children.length).toBeGreaterThan(0);
    expect(children[0].prompt).toBe(children[0].prompt.toUpperCase());
    expect(children[0].changeLog[0].label).toBe('UPPER');
    expect(seen.length).toBe(children.length);
    expect(costTracking.calls).toBe(children.length);
  });

  it('binary plugin operators receive parentB and record both lineage parents', async () => {
    registerOperator({
      name: 'merge2', parents: 2,
      apply: async ({ parent, parentB }) => ({
        prompt: parent.prompt + '+' + parentB!.prompt,
        changeLog: [{ label: 'MERGE2', text: 'merged' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });

    const parents = [makeParent('p1'), makeParent('p2')];
    const { newNodes } = await createNextGeneration(parents, makeConfig({ merge2: { share: 1 } }), 1, parents);
    const merged = newNodes.find(n => (n as any)._operatorType === 'merge2')!;
    expect(merged.lineageParents.length).toBe(2);
  });

  it('applies params patches from plugin results', async () => {
    registerOperator({
      name: 'heat', parents: 1,
      apply: async ({ parent }) => ({
        prompt: parent.prompt,
        params: { temperature: 1.5 },
        changeLog: [{ label: 'HEAT', text: 'temp up' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });
    const parents = [makeParent('p1')];
    const { newNodes } = await createNextGeneration(parents, makeConfig({ heat: { share: 1 } }), 1, parents);
    const child = newNodes.find(n => (n as any)._operatorType === 'heat')!;
    expect(child.params.temperature).toBe(1.5);
  });

  it('a throwing plugin falls back to carry-forward with ERROR changelog', async () => {
    registerOperator({
      name: 'boom', parents: 1,
      apply: async () => { throw new Error('kaput'); },
    });
    const parents = [makeParent('p1')];
    const { newNodes } = await createNextGeneration(parents, makeConfig({ boom: { share: 1 } }), 1, parents);
    const carried = newNodes.filter(n => n.changeLog.some(c => c.label === 'ERROR'));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried[0].prompt).toBe('prompt-p1');
  });

  it('ignores unknown custom operator names with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parents = [makeParent('p1')];
    const config = makeConfig({ ghost: { share: 1 } });
    config.operators.mutationShare = 0; // total known share is 0 → carry path
    const { newNodes } = await createNextGeneration(parents, config, 1, parents);
    expect(newNodes.length).toBeGreaterThan(0); // carry-forward population still produced
    expect(warn.mock.calls.some(c => String(c[0]).includes('ghost'))).toBe(true);
    warn.mockRestore();
  });

  it('custom entries override legacy fields for the same built-in name', async () => {
    const parents = [makeParent('p1')];
    const config = makeConfig({ mutation: { enabled: false, share: 0 }, upper2: { share: 1 } });
    config.operators.mutationShare = 1; // legacy says mutation share 1 — custom disables it
    registerOperator({
      name: 'upper2', parents: 1,
      apply: async ({ parent }) => ({
        prompt: parent.prompt.toUpperCase(),
        changeLog: [{ label: 'UPPER2', text: 'x' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      }),
    });
    const { newNodes } = await createNextGeneration(parents, config, 1, parents);
    expect(newNodes.some(n => (n as any)._operatorType === 'mutation')).toBe(false);
    expect(newNodes.some(n => (n as any)._operatorType === 'upper2')).toBe(true);
  });
});
```

Check `createNextGeneration`'s actual signature at `packages/core/src/engine/generation.ts:220` before running — the test above assumes `(topPerformers, config, nextGenerationNumber, currentGeneration)`; adjust the test's call sites to the real parameter order if it differs (do NOT change the production signature).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @promptengine/core packages/core/tests/engine/plugin-dispatch.test.ts`
Expected: FAIL — `operators.custom` ignored (children routed to carry/built-ins, `_operatorType 'upper'` never appears).

- [ ] **Step 3: Rewrite the dispatch section of `generation.ts`**

Replace lines 286–349 (share collection, normalization, remainder distribution, operator plan) with:

```ts
  // Step 1: Collect shares for every referenced operator (built-ins from the
  // legacy fields; plugin operators from operators.custom, which also overrides
  // legacy fields when it names a built-in).
  const shares = new Map<string, number>();
  shares.set('mutation', config.operators.mutationShare || 0);
  shares.set('crossover', config.operators.crossoverShare || 0);
  shares.set('meta', config.operators.metaPrompting?.enabled ? (config.operators.metaPrompting.share || 0) : 0);
  shares.set('param', config.operators.paramVariation?.enabled ? (config.operators.paramVariation.share || 0) : 0);
  shares.set('model', config.operators.modelVariation?.enabled ? (config.operators.modelVariation.share || 0) : 0);

  for (const [name, entry] of Object.entries(config.operators.custom ?? {})) {
    if (!getOperator(name)) {
      console.warn(`[Generation] Unknown operator '${name}' in operators.custom — is its plugin loaded? Ignoring.`);
      continue;
    }
    shares.set(name, entry.enabled === false ? 0 : (entry.share || 0));
  }

  const totalShare = [...shares.values()].reduce((a, b) => a + b, 0);
  if (totalShare === 0) {
    console.warn(`[Generation] All operator shares are 0, using pure carry-forward`);
  }

  // Step 2-3: Normalize with the largest-remainder method
  const counts = new Map<string, number>();
  const remainders: Array<{ name: string; remainder: number }> = [];
  let assigned = 0;
  for (const [name, share] of shares) {
    const quota = totalShare > 0 ? (share / totalShare) * remainingChildren : 0;
    const base = Math.floor(quota);
    counts.set(name, base);
    assigned += base;
    remainders.push({ name, remainder: quota - base });
  }
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remainingChildren - assigned; i++) {
    const r = remainders[i % remainders.length];
    counts.set(r.name, (counts.get(r.name) || 0) + 1);
  }

  console.log(`[Generation] Operator counts (normalized):`, Object.fromEntries(counts));

  // Step 4: Build shuffled operator plan
  const operatorPlan: string[] = [];
  for (const [name, n] of counts) {
    for (let i = 0; i < n; i++) operatorPlan.push(name);
  }
```

(The shuffle loop at old lines 346–349 stays as-is — it operates on `operatorPlan` regardless of element type.)

Replace the per-child creation body (old lines 372–532) with:

```ts
  for (let i = 0; i < remainingChildren; i++) {
    const operatorName = operatorPlan[i];
    const parent = nextParent();
    const parentFitness = parent.metrics?.fitness || 0;

    const childPromise = (async () => {
      const carry = (label: 'CARRY' | 'ERROR', text: string) => ({
        prompt: parent.prompt,
        changeLog: [{ label, text }] as ChangeLogLine[],
        lineageParents: [parent.id],
        params: { ...parent.params },
        operatorType: null as string | null,
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      });

      if (!operatorName) {
        return carry('CARRY', 'No operator assigned (all shares 0)');
      }
      const op = getOperator(operatorName);
      if (!op) {
        return carry('CARRY', `Operator '${operatorName}' not registered`);
      }

      try {
        const parentB = op.parents === 2 ? nextParent() : undefined;
        const result = await op.apply({ parent, parentB, config, generation: currentGeneration });

        console.log(`[Generation] Child ${i}: ${operatorName.toUpperCase()} from parent ${parent.id.slice(0, 8)}`);

        return {
          prompt: result.prompt,
          changeLog: result.changeLog,
          lineageParents: parentB && parentB.id !== parent.id ? [parent.id, parentB.id] : [parent.id],
          params: { ...parent.params, ...result.params },
          operatorType: operatorName as string | null,
          cost: result.cost,
        };
      } catch (error) {
        console.error(`[Generation] Operator '${operatorName}' failed for child ${i}:`, error);
        return carry('ERROR', `Operator '${operatorName}' failed, using parent`);
      }
    })().then(result => ({ index: i, parent, parentFitness, result }));

    childCreationPromises.push(childPromise);
  }
```

And the node-construction loop (old lines 538–561) becomes:

```ts
  for (const { parentFitness, result } of childResults) {
    totalPromptTokens += result.cost.promptTokens;
    totalCompletionTokens += result.cost.completionTokens;
    totalUsd += result.cost.usd;
    totalCalls += result.cost.calls;

    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: nextGenerationNumber,
      lineageParents: result.lineageParents,
      status: 'awaiting',
      prompt: result.prompt,
      params: { ...result.params, temperature: result.params.temperature ?? 0.7 },
      changeLog: result.changeLog,
    };

    newGenNodes.push(newNode);
    (newNode as any)._operatorType = result.operatorType;
    (newNode as any)._parentFitness = parentFitness;
  }
```

Imports: remove `mutateNode, crossoverNodes, metaPromptNode` / `varyParameters` / `varyModel` imports from `generation.ts` (now unused — they live behind the registry); add `import { getOperator } from '../registry.js';`. Keep `ChangeLogLine` imported (used by `carry`).

- [ ] **Step 4: Generalize effectiveness in `evaluator_v2.ts`**

Replace the `operatorEffectiveness` field in `EvaluationState` (lines ~42-49) with:

```ts
  operatorEffectiveness: Record<string, { totalDelta: number; count: number }>;
```

Replace its initializer in `startEvaluation`'s state construction (search for `operatorEffectiveness: {`) with `operatorEffectiveness: {},` and the tracking block (search `Operator effectiveness`) with:

```ts
      if (operatorType && parentFitness !== undefined && node.metrics?.fitness !== undefined) {
        const opKey = String(operatorType);
        if (!state.operatorEffectiveness[opKey]) {
          state.operatorEffectiveness[opKey] = { totalDelta: 0, count: 0 };
        }
        const bucket = state.operatorEffectiveness[opKey];
        const fitnessDelta = node.metrics.fitness - parentFitness;
        bucket.totalDelta += fitnessDelta;
        bucket.count++;
        const avgDelta = bucket.totalDelta / bucket.count;
        console.log(`[Evaluator] Operator effectiveness [${opKey}]: avgΔ=${avgDelta.toFixed(3)} (count=${bucket.count})`);
      }
```

(The `else { console.warn('Unknown operator type…') }` branch disappears — every operator name is now trackable.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run --project @promptengine/core` → plugin-dispatch PASSES and ALL existing engine tests still pass (generation.test.ts, generation-integration.test.ts, operators tests guard the refactor).
Run: `npm run type-check` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/generation.ts packages/core/src/engine/evaluator_v2.ts packages/core/tests/engine/plugin-dispatch.test.ts
git commit -m "Generalize operator dispatch and effectiveness tracking to the registry"
```

---

### Task 3: Plugin loader

**Files:**
- Create: `packages/core/src/pluginLoader.ts`
- Create fixtures: `packages/core/tests/fixtures/plugins/valid-operator.mjs`, `valid-provider.mjs`, `combined.mjs`, `broken.mjs`, `invalid-shape.mjs`, `dir-plugin/index.mjs`
- Modify: `packages/core/src/index.ts` (export `loadPlugins`)
- Test: `packages/core/tests/pluginLoader.test.ts`

**Interfaces:**
- Consumes: `registerOperator`, `registerProvider` (Task 1).
- Produces: `loadPlugins(opts: { dirs?: string[]; paths?: string[]; disabled?: string[] }): Promise<PluginManifest[]>` — never throws for per-module failures.

- [ ] **Step 1: Create the fixtures**

`packages/core/tests/fixtures/plugins/valid-operator.mjs`:

```js
export default {
  name: 'fixture-op',
  version: '0.1.0',
  operators: [{
    name: 'reverse-prompt',
    parents: 1,
    async apply({ parent }) {
      return {
        prompt: [...parent.prompt].reverse().join(''),
        changeLog: [{ label: 'REVERSE', text: 'reversed' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  }],
};
```

`valid-provider.mjs`:

```js
export default {
  name: 'fixture-provider',
  providers: [{
    adapter: {
      name: 'echo',
      estimateTokens: () => ({ prompt: 1 }),
      call: async ({ prompt }) => ({ output: prompt, promptTokens: 1, completionTokens: 1, latencyMs: 0, usd: 0 }),
    },
    models: [{ provider: 'echo', model: 'echo-1', promptUSDper1k: 0, completionUSDper1k: 0 }],
  }],
};
```

`combined.mjs`:

```js
export default {
  name: 'fixture-combined',
  operators: [{
    name: 'noop-op',
    parents: 1,
    async apply({ parent }) {
      return { prompt: parent.prompt, changeLog: [{ label: 'NOOP', text: '-' }], cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 } };
    },
  }],
  providers: [{
    adapter: {
      name: 'null-provider',
      estimateTokens: () => ({ prompt: 0 }),
      call: async () => ({ output: '', promptTokens: 0, completionTokens: 0, latencyMs: 0, usd: 0 }),
    },
  }],
};
```

`broken.mjs`:

```js
throw new Error('this plugin explodes at import time');
```

`invalid-shape.mjs`:

```js
export default { version: 'no name here', operators: 'not-an-array' };
```

`dir-plugin/index.mjs`:

```js
export default {
  name: 'fixture-dir',
  operators: [{
    name: 'dir-op',
    parents: 1,
    async apply({ parent }) {
      return { prompt: parent.prompt + ' [dir]', changeLog: [{ label: 'DIR', text: '-' }], cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 } };
    },
  }],
};
```

- [ ] **Step 2: Write the failing test** — `packages/core/tests/pluginLoader.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPlugins } from '../src/pluginLoader.js';
import { getOperator, listProviders, resetRegistry } from '../src/registry.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins');

beforeEach(() => resetRegistry());

describe('loadPlugins', () => {
  it('loads every module in a directory, capturing per-module errors', async () => {
    const manifests = await loadPlugins({ dirs: [FIXTURES] });

    const byName = new Map(manifests.map(m => [path.basename(m.source), m]));
    expect(byName.get('valid-operator.mjs')!.operators).toEqual(['reverse-prompt']);
    expect(byName.get('valid-provider.mjs')!.providers).toEqual(['echo']);
    expect(byName.get('combined.mjs')!.operators).toEqual(['noop-op']);
    expect(byName.get('broken.mjs')!.error).toMatch(/explodes/);
    expect(byName.get('invalid-shape.mjs')!.error).toMatch(/name/);
    expect(byName.get('index.mjs')!.operators).toEqual(['dir-op']); // dir-plugin/index.mjs

    expect(getOperator('reverse-prompt')).toBeDefined();
    expect(getOperator('dir-op')).toBeDefined();
    expect(listProviders()).toContain('echo');
  });

  it('loads explicit paths', async () => {
    const manifests = await loadPlugins({ paths: [path.join(FIXTURES, 'valid-operator.mjs')] });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeDefined();
  });

  it('skips disabled plugins with an empty manifest', async () => {
    const manifests = await loadPlugins({ paths: [path.join(FIXTURES, 'valid-operator.mjs')], disabled: ['fixture-op'] });
    expect(manifests[0].operators).toEqual([]);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeUndefined();
  });

  it('records duplicate registrations as manifest errors and keeps going', async () => {
    const p = path.join(FIXTURES, 'valid-operator.mjs');
    const manifests = await loadPlugins({ paths: [p, p] });
    expect(manifests[0].error).toBeUndefined();
    expect(manifests[1].error).toMatch(/already registered/);
  });

  it('silently skips missing directories', async () => {
    const manifests = await loadPlugins({ dirs: [path.join(FIXTURES, 'no-such-dir')] });
    expect(manifests).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run --project @promptengine/core packages/core/tests/pluginLoader.test.ts` → FAIL (module missing).

- [ ] **Step 4: Create `packages/core/src/pluginLoader.ts`**

```ts
/**
 * File-based plugin loader. A plugin is a JS module (.mjs/.js, or a directory
 * containing index.mjs/index.js) whose default export follows the contract in
 * docs/plugins.md. Per-module failures land in the returned manifests — this
 * function never throws for a bad plugin.
 *
 * Trust model: plugins are arbitrary local JavaScript executed with full
 * process privileges — the same trust level as an npm dependency.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PluginManifest, OperatorPlugin, ProviderPlugin } from './types.js';
import { registerOperator, registerProvider } from './registry.js';

export interface LoadPluginsOptions {
  dirs?: string[];
  paths?: string[];
  disabled?: string[];
}

function discover(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      found.push(full);
    } else if (entry.isDirectory()) {
      for (const index of ['index.mjs', 'index.js']) {
        const candidate = path.join(full, index);
        if (fs.existsSync(candidate)) { found.push(candidate); break; }
      }
    }
  }
  return found;
}

function validateOperator(op: any): asserts op is OperatorPlugin {
  if (!op || typeof op.name !== 'string' || !op.name) throw new Error('operator entry missing string "name"');
  if (op.parents !== 1 && op.parents !== 2) throw new Error(`operator '${op.name}' must declare parents: 1 or 2`);
  if (typeof op.apply !== 'function') throw new Error(`operator '${op.name}' missing apply() function`);
}

function validateProvider(p: any): asserts p is ProviderPlugin {
  if (!p?.adapter || typeof p.adapter.name !== 'string' || !p.adapter.name) throw new Error('provider entry missing adapter with string "name"');
  if (typeof p.adapter.call !== 'function') throw new Error(`provider '${p.adapter.name}' adapter missing call() function`);
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginManifest[]> {
  const files = [
    ...(opts.dirs ?? []).flatMap(discover),
    ...(opts.paths ?? []).map(p => path.resolve(p)),
  ];
  const disabled = new Set(opts.disabled ?? []);
  const manifests: PluginManifest[] = [];

  for (const file of files) {
    const manifest: PluginManifest = { name: path.basename(file), source: file, operators: [], providers: [] };
    manifests.push(manifest);
    try {
      const mod = await import(pathToFileURL(file).href);
      const plugin = mod.default;
      if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string' || !plugin.name) {
        throw new Error('default export must be an object with a string "name"');
      }
      manifest.name = plugin.name;
      manifest.version = plugin.version;

      if (disabled.has(plugin.name)) {
        console.log(`[Plugins] '${plugin.name}' is disabled — skipping`);
        continue;
      }

      for (const op of plugin.operators ?? []) {
        validateOperator(op);
        registerOperator(op);
        manifest.operators.push(op.name);
      }
      for (const prov of plugin.providers ?? []) {
        validateProvider(prov);
        registerProvider(prov);
        manifest.providers.push(prov.adapter.name);
      }
      console.log(`[Plugins] Loaded '${manifest.name}' (${manifest.operators.length} operators, ${manifest.providers.length} providers) from ${file}`);
    } catch (error) {
      manifest.error = error instanceof Error ? error.message : String(error);
      console.error(`[Plugins] Failed to load ${file}: ${manifest.error}`);
    }
  }
  return manifests;
}
```

Note on `plugin.operators ?? []`: when `operators` is present but not an array (fixture `invalid-shape.mjs` has `operators: 'not-an-array'` AND no name — the name check fires first there). Add an explicit array check anyway so shape errors are clear:

```ts
      if (plugin.operators !== undefined && !Array.isArray(plugin.operators)) throw new Error('"operators" must be an array');
      if (plugin.providers !== undefined && !Array.isArray(plugin.providers)) throw new Error('"providers" must be an array');
```

(insert before the two `for` loops).

- [ ] **Step 5: Export from index** — add to `packages/core/src/index.ts`:

```ts
export { loadPlugins } from './pluginLoader.js';
export type { LoadPluginsOptions } from './pluginLoader.js';
```

- [ ] **Step 6: Run tests** — loader tests PASS; full core project green; `npm run type-check` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pluginLoader.ts packages/core/src/index.ts packages/core/tests/pluginLoader.test.ts packages/core/tests/fixtures
git commit -m "Add file-based plugin loader with manifest error capture"
```

---

### Task 4: CLI host wiring

**Files:**
- Modify: `packages/cli/src/config.ts` (CliConfig `plugins?: string[]`)
- Modify: `packages/cli/src/index.ts` (`--plugins` flag; load plugins in `handleRunEvolution`; `--set-key` advisory validation)
- Modify: `packages/cli/src/store.ts` (generic env-var fallback)
- Modify: `docs/cli.md` (plugins section)
- Test: `packages/cli/tests/plugins.test.ts` (new), `packages/cli/tests/store.test.ts` (additions)

**Interfaces:**
- Consumes: `loadPlugins` from core index (Task 3).
- Produces: config field `"plugins": string[]` (paths relative to the config file); CLI flag `--plugins <dir>` (repeatable); env fallback `<PROVIDER>_API_KEY` (uppercased, `-`→`_`) for non-built-in providers.

- [ ] **Step 1: Write the failing tests**

`packages/cli/tests/plugins.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCliPlugins } from '../src/plugins.js';
import { getOperator, resetRegistry } from '@promptengine/core';

const CORE_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'core', 'tests', 'fixtures', 'plugins',
);

beforeEach(() => resetRegistry());

describe('loadCliPlugins', () => {
  it('resolves config-relative paths and loads them', async () => {
    const manifests = await loadCliPlugins({
      configDir: CORE_FIXTURES,
      configPlugins: ['./valid-operator.mjs'],
      flagDirs: [],
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeDefined();
  });

  it('merges --plugins directories', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifests = await loadCliPlugins({ configDir: '.', configPlugins: [], flagDirs: [CORE_FIXTURES] });
    expect(manifests.length).toBeGreaterThanOrEqual(5); // all fixture modules discovered
    expect(manifests.some(m => m.error)).toBe(true);    // broken.mjs reported, not thrown
    errSpy.mockRestore();
  });
});
```

`packages/cli/tests/store.test.ts` — add one describe (keep existing content):

```ts
describe('plugin provider env fallback', () => {
  it('derives <PROVIDER>_API_KEY for non-built-in providers', () => {
    process.env.MY_LOCAL_LLM_API_KEY = 'plugin-key';
    try {
      expect(resolveApiKey('my-local-llm' as any)).toBe('plugin-key');
    } finally {
      delete process.env.MY_LOCAL_LLM_API_KEY;
    }
  });
});
```

(`resolveApiKey` is already imported at the top of the existing file.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project @promptengine/cli` → FAIL (`../src/plugins.js` missing; env fallback returns null).

- [ ] **Step 3: Create `packages/cli/src/plugins.ts`**

```ts
/**
 * CLI plugin wiring: resolves config-declared plugin paths relative to the
 * config file, merges --plugins directories, loads, and reports errors to
 * stderr without aborting the run.
 */
import path from 'path';
import { loadPlugins, type PluginManifest } from '@promptengine/core';

export interface CliPluginOptions {
  configDir: string;
  configPlugins: string[];
  flagDirs: string[];
}

export async function loadCliPlugins(opts: CliPluginOptions): Promise<PluginManifest[]> {
  const paths = opts.configPlugins.map(p => path.resolve(opts.configDir, p));
  const manifests = await loadPlugins({ dirs: opts.flagDirs, paths });
  for (const m of manifests) {
    if (m.error) {
      console.error(`[Plugins] ${m.source}: ${m.error}`);
    }
  }
  return manifests;
}
```

- [ ] **Step 4: Wire into the CLI**

`packages/cli/src/config.ts` — add to the `CliConfig` interface (find `systemPrompts` field, add sibling):

```ts
  plugins?: string[]; // plugin file/dir paths, resolved relative to the config file
```

`packages/cli/src/index.ts`:
1. `parseArgs`: add a `pluginDirs: string[]` field to the result (initialize `[]`), and a case:

```ts
      case '--plugins':
        result.pluginDirs.push(args[++i]);
        break;
```

2. In `handleRunEvolution(configPath, outputPath, dbPath, pluginDirs)` (thread the new parameter from `main()`), after `installStoreShim(...)` and BEFORE `initCliDatabase(dbPath)` (plugin provider models must be queued before the db flush):

```ts
  // Load plugins (config-relative paths + --plugins dirs) before the database
  // opens so plugin provider model entries flush into model_costs.
  const pathMod = await import('path');
  const cfgDir = pathMod.dirname(pathMod.resolve(configPath));
  const { loadCliPlugins } = await import('./plugins.js');
  await loadCliPlugins({ configDir: cfgDir, configPlugins: cliConfig.plugins ?? [], flagDirs: pluginDirs });
```

(The existing `configDir` computed later for `toEvaluationConfig` can reuse `cfgDir` — deduplicate.)
3. `--set-key` validation becomes advisory:

```ts
        if (!VALID_PROVIDERS.includes(provider)) {
          console.error(`Note: "${provider}" is not a built-in provider — saving the key anyway (plugin provider assumed).`);
        }
```

(Remove the `process.exit(1)` for unknown providers; keep the missing-key exit.)
4. `printHelp()`: add under OPTIONS: `  --plugins <dir>              Load plugins from a directory (repeatable)` and a PLUGINS section pointing to `docs/plugins.md`.

`packages/cli/src/store.ts` — in `resolveApiKey`, replace the env-var lookup:

```ts
  const envVar = ENV_VAR_MAP[provider] ?? `${String(provider).toUpperCase().replace(/-/g, '_')}_API_KEY`;
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }
```

(`ENV_VAR_MAP`'s type changes to `Partial<Record<Provider, string>>` — with the opened `Provider` union the exhaustive `Record` no longer type-checks.)

- [ ] **Step 5: Update `docs/cli.md`** — add a `## Plugins` section after the config-file docs:

```markdown
## Plugins

Extend the engine with custom operators and providers (author guide: [plugins.md](plugins.md)).

- Config field: `"plugins": ["./my-operator.mjs", "./plugin-dir"]` — paths relative to the config file.
- Flag: `--plugins <dir>` (repeatable) — loads every plugin module in the directory.
- Plugin operator shares go under `"operators": { "custom": { "<operator-name>": { "share": 0.5 } } }`.
- Keys for plugin providers resolve from `<PROVIDER>_API_KEY` (uppercased, dashes→underscores) or `--set-key <provider> <key>`.
- A plugin that fails to load prints an error to stderr; the run continues without it.
```

- [ ] **Step 6: Run tests** — `npx vitest run --project @promptengine/cli` → PASS; `npm run type-check` clean; smoke: `npm run cli -- --help` shows `--plugins`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/plugins.ts packages/cli/src/config.ts packages/cli/src/index.ts packages/cli/src/store.ts packages/cli/tests/plugins.test.ts packages/cli/tests/store.test.ts docs/cli.md
git commit -m "CLI plugin loading: config plugins field, --plugins flag, generic provider env keys"
```

---

### Task 5: Desktop host — startup loading, IPC, preload

**Files:**
- Create: `apps/desktop/electron/ipc/plugins.ts`
- Modify: `apps/desktop/electron/main.ts` (load plugins at startup)
- Modify: `apps/desktop/electron/preload.ts` (expose `plugins` API)
- Modify: `apps/desktop/src/window.d.ts` (typing)
- Test: `apps/desktop/tests/ipc/plugins.test.ts` (new)

**Interfaces:**
- Consumes: `loadPlugins`, `PluginManifest` from core.
- Produces: IPC channels `plugins:list` → `{ manifests: PluginManifest[]; disabled: string[] }`; `plugins:setEnabled(name: string, enabled: boolean)` → persists `disabledPlugins: string[]` via the injected store; `plugins:openFolder` → creates + opens the plugins dir. Renderer surface `window.electronAPI.plugins.{list, setEnabled, openFolder}`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/tests/ipc/plugins.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeBacking } = vi.hoisted(() => ({ storeBacking: {} as Record<string, any> }));

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
vi.mock('@promptengine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@promptengine/core')>()),
  store: {
    get: (k: string, d?: any) => storeBacking[k] ?? d ?? null,
    set: (k: string, v: any) => { storeBacking[k] = v; },
    store: storeBacking,
  },
}));

import { registerPluginHandlers, setPluginState } from '../../electron/ipc/plugins';

const channels = new Map<string, (...args: any[]) => Promise<any>>();
const mockIpcMain = { handle: vi.fn((ch: string, fn: any) => channels.set(ch, fn)) } as any;
const invoke = (ch: string, ...args: any[]) => channels.get(ch)!({} as any, ...args);

beforeEach(() => {
  channels.clear();
  for (const k of Object.keys(storeBacking)) delete storeBacking[k];
  setPluginState({
    manifests: [
      { name: 'alpha', source: '/p/alpha.mjs', operators: ['op-a'], providers: [] },
      { name: 'beta', source: '/p/beta.mjs', operators: [], providers: [], error: 'boom' },
    ],
    pluginsDir: '/p',
  });
  registerPluginHandlers(mockIpcMain);
});

describe('plugin IPC handlers', () => {
  it('plugins:list returns manifests and the disabled list', async () => {
    storeBacking['disabledPlugins'] = ['beta'];
    const res = await invoke('plugins:list');
    expect(res.manifests.map((m: any) => m.name)).toEqual(['alpha', 'beta']);
    expect(res.disabled).toEqual(['beta']);
  });

  it('plugins:setEnabled(false) adds to disabledPlugins; (true) removes', async () => {
    await invoke('plugins:setEnabled', 'alpha', false);
    expect(storeBacking['disabledPlugins']).toEqual(['alpha']);
    await invoke('plugins:setEnabled', 'alpha', true);
    expect(storeBacking['disabledPlugins']).toEqual([]);
  });

  it('plugins:openFolder creates the dir and opens it', async () => {
    const res = await invoke('plugins:openFolder');
    expect(res).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project desktop apps/desktop/tests/ipc/plugins.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `apps/desktop/electron/ipc/plugins.ts`**

```ts
import type { IpcMain } from 'electron';
import fs from 'fs';
import { store, type PluginManifest } from '@promptengine/core';

interface PluginState {
  manifests: PluginManifest[];
  pluginsDir: string;
}

let state: PluginState = { manifests: [], pluginsDir: '' };

export function setPluginState(next: PluginState): void {
  state = next;
}

export function registerPluginHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('plugins:list', async () => ({
    manifests: state.manifests,
    disabled: (store.get('disabledPlugins', []) as string[]) ?? [],
  }));

  ipcMain.handle('plugins:setEnabled', async (_event, name: string, enabled: boolean) => {
    const disabled = new Set((store.get('disabledPlugins', []) as string[]) ?? []);
    if (enabled) disabled.delete(name); else disabled.add(name);
    store.set('disabledPlugins', [...disabled]);
    return [...disabled];
  });

  ipcMain.handle('plugins:openFolder', async () => {
    const { shell } = await import('electron');
    fs.mkdirSync(state.pluginsDir, { recursive: true });
    await shell.openPath(state.pluginsDir);
    return true;
  });
}
```

- [ ] **Step 4: Wire startup in `apps/desktop/electron/main.ts`**

Add imports: `import { loadPlugins } from '@promptengine/core';` and `import { registerPluginHandlers, setPluginState } from './ipc/plugins.js';`
Inside `app.whenReady().then(async () => {` — after `setStore(...)` / `setSendUpdate(...)`, BEFORE `initializeDatabase(...)`:

```ts
  // Load plugins before the database opens so plugin provider models flush
  // into the catalog. Disabled plugins are skipped (Settings → Plugins).
  const pluginsDir = path.join(app.getPath('userData'), 'plugins');
  const disabledPlugins = (new Store({ encryptionKey: 'prompt-evolution-secure-key' }).get('disabledPlugins', []) as string[]) ?? [];
  const pluginManifests = await loadPlugins({ dirs: [pluginsDir], disabled: disabledPlugins });
  setPluginState({ manifests: pluginManifests, pluginsDir });
```

Simplification: the store is already injected two lines above — reuse it instead of constructing a second `Store`. Hoist the instance:

```ts
  const electronStore = new Store({ encryptionKey: 'prompt-evolution-secure-key' }) as unknown as StoreInterface;
  setStore(electronStore);
  ...
  const disabledPlugins = (electronStore.get('disabledPlugins', []) as string[]) ?? [];
```

And after `registerIPCHandlers(ipcMain);` add `registerPluginHandlers(ipcMain);`.

- [ ] **Step 5: Preload + typing**

`apps/desktop/electron/preload.ts` — inside the exposed API object (after the `logs` section):

```js
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (name, enabled) => ipcRenderer.invoke('plugins:setEnabled', name, enabled),
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  },
```

`apps/desktop/src/window.d.ts` — add to the `electronAPI` interface:

```ts
  plugins: {
    list: () => Promise<{ manifests: Array<{ name: string; version?: string; source: string; operators: string[]; providers: string[]; error?: string }>; disabled: string[] }>;
    setEnabled: (name: string, enabled: boolean) => Promise<string[]>;
    openFolder: () => Promise<boolean>;
  };
```

- [ ] **Step 6: Run tests + boot smoke**

Run: `npx vitest run --project desktop` → PASS; `npm run type-check` → clean.
Smoke: `npm run electron:dev` in background; wait for `built in`; confirm no startup errors mentioning `plugins` or `loadPlugins` in output (empty plugins dir case); kill electron processes.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/ipc/plugins.ts apps/desktop/electron/main.ts apps/desktop/electron/preload.ts apps/desktop/src/window.d.ts apps/desktop/tests/ipc/plugins.test.ts
git commit -m "Desktop plugin host: startup loading, plugins IPC, preload surface"
```

---

### Task 6: UI — Settings panel + plugin operator sliders + label tolerance

**Files:**
- Modify: `apps/desktop/src/components/SettingsModal.tsx` (Plugins section)
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (plugin operators group)
- Check/Modify: `apps/desktop/src/components/CenterView.tsx` (changelog label styling fallback)

No automated component tests exist in this repo — the gate for this task is `npm run type-check` + a driven boot smoke.

- [ ] **Step 1: Settings → Plugins section**

In `SettingsModal.tsx`, add state + fetch (pattern-match the modal's existing data loading):

```tsx
const [pluginInfo, setPluginInfo] = useState<{ manifests: any[]; disabled: string[] } | null>(null);

useEffect(() => {
  window.electronAPI.plugins.list().then(setPluginInfo).catch(() => setPluginInfo({ manifests: [], disabled: [] }));
}, []);

const togglePlugin = async (name: string, enabled: boolean) => {
  const disabled = await window.electronAPI.plugins.setEnabled(name, enabled);
  setPluginInfo(info => info ? { ...info, disabled } : info);
};
```

Render section (place after the existing models/costs section, matching the modal's section styling):

```tsx
<div className="space-y-2">
  <h3 className="text-sm font-semibold">Plugins</h3>
  <p className="text-xs text-muted-foreground">
    Plugins are local JavaScript with full access — treat them like installed dependencies. Changes apply after restart.
  </p>
  {pluginInfo && pluginInfo.manifests.length === 0 && (
    <p className="text-xs text-muted-foreground">No plugins installed.</p>
  )}
  {pluginInfo?.manifests.map(m => (
    <div key={m.source} className="flex items-center justify-between rounded border p-2 text-sm">
      <div>
        <span className="font-medium">{m.name}</span>
        {m.version && <span className="ml-1 text-xs text-muted-foreground">v{m.version}</span>}
        <div className="text-xs text-muted-foreground">
          {m.error
            ? <span className="text-red-500">Failed to load: {m.error}</span>
            : `${m.operators.length} operator(s), ${m.providers.length} provider(s)`}
        </div>
      </div>
      {!m.error && (
        <Switch
          checked={!pluginInfo.disabled.includes(m.name)}
          onCheckedChange={(v) => togglePlugin(m.name, v)}
        />
      )}
    </div>
  ))}
  <Button variant="outline" size="sm" onClick={() => window.electronAPI.plugins.openFolder()}>
    Open plugins folder
  </Button>
</div>
```

(`Switch` and `Button` are already imported in this modal; if not, import from `@/components/ui/switch` / `@/components/ui/button`.)

- [ ] **Step 2: NewEvaluationModal plugin operators group**

Add plugin operator state next to the existing modal state:

```tsx
const [pluginOperators, setPluginOperators] = useState<Array<{ name: string; label?: string; description?: string }>>([]);

useEffect(() => {
  window.electronAPI.plugins.list().then(({ manifests, disabled }) => {
    const ops = manifests
      .filter(m => !m.error && !disabled.includes(m.name))
      .flatMap(m => m.operators.map(name => ({ name })));
    setPluginOperators(ops);
  }).catch(() => {});
}, []);
```

Render inside the operators tab content, after the existing operator controls:

```tsx
{pluginOperators.length > 0 && (
  <div className="space-y-2 border-t pt-3">
    <LabelWithTooltip
      htmlFor="plugin-operators"
      label="Plugin operators"
      tooltip="Operators contributed by installed plugins. Shares mix with the built-in operators and are normalized together."
    />
    {pluginOperators.map(op => (
      <div key={op.name} className="flex items-center gap-2">
        <span className="w-48 text-sm">{op.label ?? op.name}</span>
        <Input
          type="number" min={0} max={1} step={0.05}
          value={config.operators?.custom?.[op.name]?.share ?? 0}
          onChange={(e) => setConfig({
            ...config,
            operators: {
              ...config.operators!,
              custom: {
                ...config.operators?.custom,
                [op.name]: { enabled: true, share: parseFloat(e.target.value) || 0 },
              },
            },
          })}
        />
      </div>
    ))}
  </div>
)}
```

(Match the modal's actual state setter — it uses `setConfig` with a `Partial<EvaluationConfig>`; the operators tab lives where `mutationShare` inputs are rendered — search for `mutationShare` in the file. `Input`/`LabelWithTooltip` import patterns already exist in the file.)

- [ ] **Step 3: Changelog label tolerance in `CenterView.tsx`**

Search for `ChangeLabel`/label styling (`grep -n "MUTATION" apps/desktop/src/components/CenterView.tsx apps/desktop/src/components/RightPanel.tsx`). If label→color lookup is a `Record<ChangeLabel, string>` indexed directly, add a fallback: `labelColors[label] ?? 'bg-gray-500'` (or the file's equivalent default style). If it already uses a default branch, no change.

- [ ] **Step 4: Verify**

Run: `npm run type-check` → clean.
Boot smoke with a real plugin: copy `packages/core/tests/fixtures/plugins/valid-operator.mjs` into `%APPDATA%/evolution2/plugins/` (create dir), `npm run electron:dev`, confirm via the CDP driver (scratchpad `cdp/cdp.mjs`) or log output that startup prints `[Plugins] Loaded 'fixture-op'`; open Settings → Plugins shows the row; kill electron; remove the copied fixture file.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/SettingsModal.tsx apps/desktop/src/components/NewEvaluationModal.tsx apps/desktop/src/components/CenterView.tsx
git commit -m "Plugins UI: settings panel with enable/disable, dynamic plugin operator shares"
```

(Drop `CenterView.tsx` from the add list if Step 3 required no change.)

---

### Task 7: Example plugins, author guide, docs sync, final verification

**Files:**
- Create: `examples/plugins/section-shuffle.mjs`, `examples/plugins/ollama/index.mjs`, `examples/plugins/README.md`
- Create: `docs/plugins.md` (author guide)
- Test: `packages/core/tests/examples.test.ts`
- Modify: `README.md` (plugins bullet + layout), `ROADMAP.md` (Phase 5 → done), `CLAUDE.md` (registry/loader in architecture notes)

- [ ] **Step 1: Example operator** — `examples/plugins/section-shuffle.mjs`:

```js
/**
 * Example PromptEngine operator plugin (LLM-free, deterministic).
 * Rotates double-newline-separated prompt sections: the first section moves
 * to the end. Useful as a template for your own operators.
 */
export default {
  name: 'section-shuffle',
  version: '1.0.0',
  operators: [{
    name: 'section-shuffle',
    label: 'Section Shuffle',
    description: 'Rotates prompt sections to escape ordering-based local optima',
    parents: 1,
    async apply({ parent }) {
      const sections = parent.prompt.split(/\n\n+/);
      const rotated = sections.length > 1 ? [...sections.slice(1), sections[0]] : sections;
      return {
        prompt: rotated.join('\n\n'),
        changeLog: [{ label: 'SECTION-SHUFFLE', text: `Rotated ${sections.length} sections` }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  }],
};
```

- [ ] **Step 2: Example provider** — `examples/plugins/ollama/index.mjs`:

```js
/**
 * Example PromptEngine provider plugin: local Ollama server via its
 * OpenAI-compatible endpoint (http://localhost:11434). No API key needed.
 * Requires: `ollama serve` running and the model pulled (e.g. `ollama pull llama3.2`).
 */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const adapter = {
  name: 'ollama',
  estimateTokens(input) {
    return { prompt: Math.ceil(input.length / 4) };
  },
  async call({ model, prompt, temperature, maxTokens }) {
    const started = Date.now();
    const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return {
      output: data.choices?.[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      usd: 0, // local inference is free
    };
  },
};

export default {
  name: 'ollama',
  version: '1.0.0',
  providers: [{
    adapter,
    models: [
      { provider: 'ollama', model: 'llama3.2', promptUSDper1k: 0, completionUSDper1k: 0 },
      { provider: 'ollama', model: 'qwen2.5', promptUSDper1k: 0, completionUSDper1k: 0 },
    ],
  }],
};
```

- [ ] **Step 3: Test the examples** — `packages/core/tests/examples.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPlugins } from '../src/pluginLoader.js';
import { getOperator, resetRegistry } from '../src/registry.js';
import { getProviderAdapter } from '../src/providers/index.js';
import type { CandidateNode, EvaluationConfig } from '../src/types.js';

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'plugins');

beforeEach(() => resetRegistry());

describe('example plugins', () => {
  it('section-shuffle rotates sections deterministically', async () => {
    const manifests = await loadPlugins({ paths: [path.join(EXAMPLES, 'section-shuffle.mjs')] });
    expect(manifests[0].error).toBeUndefined();

    const op = getOperator('section-shuffle')!;
    const parent = { prompt: 'A\n\nB\n\nC', params: { model: { provider: 'x', model: 'y' }, temperature: 0.7 } } as CandidateNode;
    const result = await op.apply({ parent, config: {} as EvaluationConfig, generation: [] });
    expect(result.prompt).toBe('B\n\nC\n\nA');
  });

  it('ollama adapter parses OpenAI-compatible responses', async () => {
    const manifests = await loadPlugins({ paths: [path.join(EXAMPLES, 'ollama', 'index.mjs')] });
    expect(manifests[0].error).toBeUndefined();

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'hello from llama' } }],
      usage: { prompt_tokens: 7, completion_tokens: 4 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const adapter = getProviderAdapter('ollama');
      const result = await adapter.call({ model: 'llama3.2', prompt: 'hi', temperature: 0.5, maxTokens: 100 });
      expect(result.output).toBe('hello from llama');
      expect(result.promptTokens).toBe(7);
      expect(result.usd).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

Run first → FAIL (files missing) → create Steps 1-2 files → PASS.

- [ ] **Step 3b: End-to-end — full evolution through a plugin operator AND a plugin provider (zero LLM calls)**

Append to `packages/core/tests/examples.test.ts`:

```ts
import os from 'os';
import fs from 'fs';
import { initializeDatabase, closeDatabase, getDatabase, setStore, setSendUpdate, startEvaluation } from '../src/index.js';

describe('end-to-end evolution via plugins', () => {
  const tmpDb = path.join(os.tmpdir(), `pe-plugin-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

  it('evolves with the echo provider and section-shuffle operator only', async () => {
    setStore({ get: () => null, set: () => {}, store: {} });
    await loadPlugins({
      paths: [
        path.join(EXAMPLES, 'section-shuffle.mjs'),
        // echo provider fixture from the loader tests
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins', 'valid-provider.mjs'),
      ],
    });
    await initializeDatabase(tmpDb);

    const config = {
      id: 'e2e-cfg', name: 'plugin e2e',
      selection: { policy: 'topk', topK: 1 },
      operators: { mutationShare: 0, crossoverShare: 0, custom: { 'section-shuffle': { share: 1 } } },
      population: { initialSize: 1, generationSize: 1, seedPrompt: 'Alpha\n\nBeta', fill: 'auto' },
      enabledModels: [{ provider: 'echo', model: 'echo-1' }],
      testSet: [{ id: 't1', name: 'echo test', mode: 'exact_match', prompt: 'ping', expected: 'anything' }],
      fitness: { weights: { quality: 1 } },
      targets: { maxGenerations: 2 },
      serviceModel: { provider: 'echo', model: 'echo-1' },
      parallelLimit: 1, serviceModelMaxTokens: 100, retries: 1,
    } as any;

    const events: any[] = [];
    const finished = new Promise<void>((resolve) => {
      setSendUpdate((_runId, data) => {
        events.push(data);
        if (data.type === 'status' && data.status === 'finished') resolve();
      });
    });

    const run = {
      id: 'e2e-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
      generations: [], cacheHits: 0, version: '1.0',
    } as any;
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    await startEvaluation(run.id, config, run);
    await finished;

    const nodes = events.filter(e => e.type === 'node_updated').map(e => e.node);
    const gen1 = nodes.filter(n => n.generation === 1);
    expect(gen1.length).toBeGreaterThan(0);
    expect(gen1.some(n => n.changeLog.some((c: any) => c.label === 'SECTION-SHUFFLE'))).toBe(true);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 20000);
});
```

Run: this test may surface integration issues (event names, node shapes) — fix the TEST expectations against observed engine events, never the engine. If `startEvaluation` requires fields not listed here, extend `config` minimally until the run finishes.

- [ ] **Step 4: Author guide** — `docs/plugins.md`:

```markdown
# Writing PromptEngine Plugins

A plugin is a single JavaScript module (`.mjs`/`.js` file, or a folder with `index.mjs`) that default-exports:

```js
export default {
  name: 'my-plugin',          // required, unique
  version: '1.0.0',           // optional
  operators: [ /* ... */ ],   // optional
  providers: [ /* ... */ ],   // optional
};
```

Working examples: [`examples/plugins/`](../examples/plugins/).

## Where plugins load from

- **Desktop app**: the `plugins/` folder inside the app's user-data directory (Settings → Plugins → "Open plugins folder"). Enable/disable per plugin in Settings; changes apply on restart.
- **CLI**: `"plugins": ["./my-plugin.mjs"]` in the config JSON (paths relative to the config file) or `--plugins <dir>`.

## Operators

```js
{
  name: 'section-shuffle',       // unique id: used in config shares, changelogs, effectiveness stats
  label: 'Section Shuffle',      // UI display name
  description: '...',
  parents: 1,                    // 1 = unary (gets `parent`), 2 = binary (also gets `parentB`)
  async apply({ parent, parentB, config, generation }) {
    return {
      prompt: '...',                                    // the child's prompt (required)
      params: { temperature: 1.2 },                     // optional patch: temperature, seed, model
      changeLog: [{ label: 'MY-LABEL', text: '...' }],  // shown in the lineage graph
      cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },  // accumulate real LLM spend here
    };
  },
}
```

- Give users a share via `operators.custom` in the evaluation config: `{ "custom": { "section-shuffle": { "share": 0.3 } } }`. Shares are normalized together with the built-in operators.
- Need an LLM inside your operator? `import { getProviderAdapter } from '@promptengine/core'` and call the service model from `config.serviceModel` — report the spend in `cost`.
- Throwing from `apply()` is safe: the engine falls back to carrying the parent forward with an `ERROR` changelog entry.

## Providers

```js
{
  adapter: {                       // implements the ProviderAdapter interface
    name: 'ollama',                // provider id: used in model refs ("ollama/llama3.2") and key lookup
    estimateTokens(input) { return { prompt: input.length / 4 }; },
    async call({ model, prompt, temperature, seed, maxTokens, providerOptions, images }) {
      return { output, promptTokens, completionTokens, latencyMs, usd };
    },
  },
  models: [                        // optional: seeds the model catalog (pricing per 1k tokens)
    { provider: 'ollama', model: 'llama3.2', promptUSDper1k: 0, completionUSDper1k: 0 },
  ],
}
```

- Prefer subclassing `BaseProviderAdapter` (exported from `@promptengine/core`) to inherit retry, concurrency-semaphore, and stored-key handling; implement `callAPI()` and `getApiKey()`.
- API keys resolve from `<PROVIDER>_API_KEY` env vars (uppercased, dashes→underscores), `--set-key`, or the desktop Settings.

## Trust model

Plugins are arbitrary local JavaScript executed with full process privileges — exactly the trust level of an npm dependency. Only install plugins you trust. There is no sandbox.
```

- [ ] **Step 5: Example README** — `examples/plugins/README.md`:

```markdown
# Example plugins

- `section-shuffle.mjs` — minimal LLM-free operator (deterministic section rotation)
- `ollama/` — provider adapter for a local Ollama server (free local models)

Try them:

```bash
# CLI: add to your evolution config
#   "plugins": ["../examples/plugins/section-shuffle.mjs"],
#   "operators": { "custom": { "section-shuffle": { "share": 0.3 } } }

# Desktop: copy into the app's plugins folder (Settings → Plugins → Open plugins folder)
```

Author guide: [docs/plugins.md](../../docs/plugins.md)
```

- [ ] **Step 6: Docs sync**

- `README.md`: in "Dials worth knowing" table add row: `| Plugins | Drop a JS file in the plugins folder to add operators or providers — [docs/plugins.md](docs/plugins.md) |`; in the repository layout block add `examples/plugins   drop-in operator/provider examples (Ollama, section-shuffle)`.
- `ROADMAP.md`: Phase 5 row → `✅ Done — registry + loader in core, both hosts, Settings panel, examples`; move its detail section under a "Done" heading or delete (status table is the record); Phase 6 remains the active phase.
- `CLAUDE.md`: in the core architecture section add: `**Plugins**: registry.ts (operator/provider registries; built-ins pre-registered) + pluginLoader.ts (file-based loading, manifest error capture). Docs: docs/plugins.md.`

- [ ] **Step 7: Final verification**

```bash
npx vitest run          # every suite green
npm run type-check      # clean
npm run cli -- --help   # shows --plugins
npm run build:packages  # tsup builds still succeed
```

- [ ] **Step 8: Commit**

```bash
git add examples/plugins docs/plugins.md packages/core/tests/examples.test.ts README.md ROADMAP.md CLAUDE.md
git commit -m "Example plugins (section-shuffle, Ollama), author guide, docs sync"
```
