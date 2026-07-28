# Preflight Cost Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `estimateRunCost(config, getCost)` computes an honest low/high spend band and call count from pure arithmetic; surfaced as a CLI startup banner, a `--estimate` dry-run flag, and a live line in the desktop New Evaluation modal.

**Architecture:** One pure module (`engine/estimate.ts`) models every call phase we ship (fill, candidate evals, grading, safety, stability, operators, playoff, holdout) against real prompt lengths and catalog prices; hosts inject the price lookup (`getModelCost`). CLI and desktop are thin presenters.

**Tech Stack:** existing stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-cost-estimate-design.md` (the call-model table and token/price constants there are normative).

## Global Constraints

- Commit messages: NEVER add attribution trailers; stage exact paths, never `git add -A`.
- ESM `.js` suffixes; strict TS; after every task `npx vitest run` green AND bare `npm run type-check` (never piped).
- Estimation failure must NEVER block or fail a run (banner path catches and prints one stderr note).
- Constants (verbatim from spec): candidate completion low 100 / high `min(maxTokens ?? 20000, 1024)`; judge low 80 / high 250; mutation/meta-apply low 200 / high `min(maxTokens, 1024)`; prompt growth factor 1.2; service template overhead 400 tokens; ~4 chars/token.
- Repo files are CRLF — scripted regex edits need `\r?\n`.
- Work on branch `cost-estimate` off `master`.

---

### Task 1: estimate.ts + unit tests

**Files:**
- Create: `packages/core/src/engine/estimate.ts`
- Modify: `packages/core/src/index.ts` (export `estimateRunCost` + type `CostEstimate`; verify `getModelCost` is exported — add `export { getModelCost } from './providers/costs.js';` if missing)
- Test: `packages/core/tests/engine/estimate.test.ts`

**Interfaces:**
- Produces: `estimateRunCost(config: EvaluationConfig, getCost: (model: ModelRef) => Promise<ModelCostEntry | null>): Promise<CostEstimate>` with `CostEstimate = { calls: number; low: number; high: number; perGeneration: boolean; breakdown: Array<{ label: string; calls: number; low: number; high: number }>; warnings: string[] }`.

- [ ] **Step 1: Failing tests** — `packages/core/tests/engine/estimate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { estimateRunCost } from '../../src/engine/estimate.js';
import type { ModelRef, ModelCostEntry } from '../../src/types.js';

// Flat price table: every model $0.001/1k prompt, $0.002/1k completion
const flatCost = async (m: ModelRef): Promise<ModelCostEntry | null> => ({
  provider: m.provider, model: m.model, promptUSDper1k: 0.001, completionUSDper1k: 0.002,
});
const noCost = async (): Promise<ModelCostEntry | null> => null;

const base = (over: any = {}) => ({
  id: 'e', name: 'e',
  selection: { policy: 'topk', topK: 2, eliteShare: 0.05 },
  operators: { mutationShare: 1, crossoverShare: 0 },
  population: { initialSize: 3, generationSize: 3, seedPrompt: 'SEED '.repeat(20), fill: 'auto' },
  enabledModels: [{ provider: 'x', model: 'm1' }],
  serviceModel: { provider: 'x', model: 'svc' },
  testSet: [
    { id: 't1', name: 'a', mode: 'llm_grade', prompt: 'P'.repeat(200) },
    { id: 't2', name: 'b', mode: 'exact_match', prompt: 'Q'.repeat(200), expected: 'x' },
  ],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 2 },
  serviceModelMaxTokens: 20000, retries: 1, parallelLimit: 2,
  ...over,
} as any);

describe('estimateRunCost call model', () => {
  it('counts the hand-computed baseline exactly', async () => {
    // N0=3, N=3, G=2, E=max(1,round(3*0.05))=1, F=2 (L=1), S=1, transitions=1
    // nodes = 3 + 1*(3-1) = 5
    // fill (3-1)*2=4 | cand 5*2*1=10 | grading 5*1*1=5 | operators 1 transition * 2 children * 2 (mutation) = 4
    const e = await estimateRunCost(base(), flatCost);
    expect(e.calls).toBe(4 + 10 + 5 + 4);
    expect(e.perGeneration).toBe(false);
    expect(e.low).toBeGreaterThan(0);
    expect(e.low).toBeLessThanOrEqual(e.high);
    const labels = e.breakdown.map(b => b.label);
    expect(labels).toContain('Candidate evaluations');
    expect(labels).toContain('LLM grading');
  });

  it('samplesPerTest multiplies evals and grading', async () => {
    const e1 = await estimateRunCost(base(), flatCost);
    const e3 = await estimateRunCost(base({ samplesPerTest: 3 }), flatCost);
    // evals 10→30 (+20), grading 5→15 (+10); fill+operators unchanged
    expect(e3.calls).toBe(e1.calls + 30);
  });

  it('playoff adds pairs × L × 2 per generation', async () => {
    const e = await estimateRunCost(base({ pairwise: { enabled: true, contenders: 3 } }), flatCost);
    const noPlayoff = await estimateRunCost(base(), flatCost);
    // contenders min(3,3)=3 → 3 pairs; L=1; G=2 → 2*3*1*2 = 12
    expect(e.calls).toBe(noPlayoff.calls + 12);
  });

  it('holdout tests leave evolution and add the final evaluation', async () => {
    const cfg = base();
    cfg.testSet.push({ id: 'h1', name: 'h', mode: 'llm_grade', prompt: 'H'.repeat(100), holdout: true });
    const e = await estimateRunCost(cfg, flatCost);
    const noHold = await estimateRunCost(base(), flatCost);
    // F stays 2 (flagged test excluded) — evolution calls unchanged;
    // holdout: 2*1*1 evals + 2*1*1 grading = 4 extra
    expect(e.calls).toBe(noHold.calls + 4);
    expect(e.breakdown.map(b => b.label)).toContain('Holdout evaluation');
  });

  it('safety and stability add per-node calls when weighted', async () => {
    const e = await estimateRunCost(base({
      fitness: { weights: { quality: 1, safety: 0.2, stability: 0.1 }, guardrails: ['no pii', 'no slang'] },
    }), flatCost);
    const plain = await estimateRunCost(base(), flatCost);
    // nodes=5: safety 5*2=10, stability 5*3=15
    expect(e.calls).toBe(plain.calls + 25);
  });

  it('unset maxGenerations => perGeneration estimate (one gen-0 pass + one transition)', async () => {
    const e = await estimateRunCost(base({ targets: {} }), flatCost);
    expect(e.perGeneration).toBe(true);
    expect(e.calls).toBeGreaterThan(0);
  });

  it('uncatalogued model warns and prices at zero', async () => {
    const e = await estimateRunCost(base(), noCost);
    expect(e.low).toBe(0);
    expect(e.warnings.some(w => w.includes('not in catalog'))).toBe(true);
  });

  it('budget below the low estimate warns', async () => {
    const e = await estimateRunCost(base({ targets: { maxGenerations: 2, budgetUSD: 0.0000001 } }), flatCost);
    expect(e.warnings.some(w => w.includes('below the low estimate'))).toBe(true);
  });

  it('plugin operator shares count 0 calls but warn', async () => {
    const e = await estimateRunCost(base({ operators: { mutationShare: 0.5, crossoverShare: 0, custom: { myop: { share: 0.5 } } } }), flatCost);
    expect(e.warnings.some(w => w.includes('plugin'))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement `packages/core/src/engine/estimate.ts`**:

```ts
/**
 * Preflight cost estimation: pure arithmetic over the run's call structure.
 * Completion lengths are the one true unknown, so results are a low/high band.
 * Never throws for config oddities — degrades to warnings.
 */
import type { EvaluationConfig, ModelRef, ModelCostEntry } from '../types.js';
import { partitionTestSet } from './holdout.js';

export interface CostEstimate {
  calls: number;
  low: number;
  high: number;
  perGeneration: boolean;
  breakdown: Array<{ label: string; calls: number; low: number; high: number }>;
  warnings: string[];
}

const tok = (s: string | undefined) => Math.ceil((s?.length ?? 0) / 4);

interface Price { promptUSDper1k: number; completionUSDper1k: number }

export async function estimateRunCost(
  config: EvaluationConfig,
  getCost: (model: ModelRef) => Promise<ModelCostEntry | null>,
): Promise<CostEstimate> {
  const warnings: string[] = [];

  const priceOf = async (models: ModelRef[]): Promise<Price> => {
    let p = 0, c = 0;
    for (const m of models) {
      const entry = await getCost(m);
      if (!entry || (entry.promptUSDper1k === 0 && entry.completionUSDper1k === 0)) {
        warnings.push(`${m.provider}/${m.model} not in catalog — estimated at $0`);
      }
      p += entry?.promptUSDper1k ?? 0;
      c += entry?.completionUSDper1k ?? 0;
    }
    const n = Math.max(1, models.length);
    return { promptUSDper1k: p / n, completionUSDper1k: c / n };
  };

  const perGeneration = config.targets.maxGenerations === undefined;
  const G = perGeneration ? 1 : config.targets.maxGenerations!;
  const N = config.population.generationSize;
  const N0 = config.population.initialSize;
  const eliteShare = config.selection.eliteShare ?? 0;
  const E = eliteShare > 0 ? Math.max(1, Math.round(N * eliteShare)) : 0;
  const S = Math.min(Math.max(Math.floor(config.samplesPerTest ?? 1), 1), 10);
  const { fitnessTests, holdoutTests } = partitionTestSet(
    config.testSet, config.holdoutShare ?? 0, config.holdoutSeed ?? config.seed ?? 42);
  const F = fitnessTests.length;
  const L = fitnessTests.filter(t => t.mode === 'llm_grade').length;
  const H = holdoutTests.length;
  const Hllm = holdoutTests.filter(t => t.mode === 'llm_grade').length;
  const transitions = perGeneration ? 1 : Math.max(0, G - 1);
  const nodes = N0 + transitions * (N - E);

  const cand = await priceOf(config.enabledModels ?? []);
  const svc = await priceOf([config.serviceModel]);

  const seedTok = tok(config.population.seedPrompt);
  const avgTestTok = F > 0 ? fitnessTests.reduce((a, t) => a + tok(t.prompt), 0) / F : 0;
  const candPromptTok = Math.ceil((seedTok + avgTestTok) * 1.2);
  const svcPromptTok = Math.ceil(seedTok * 1.2) + 400;
  const judgePromptTok = candPromptTok + 400;
  const maxOut = Math.min(config.serviceModelMaxTokens || 20000, 1024);

  const per = (p: Price, promptT: number, compT: number) =>
    (promptT / 1000) * p.promptUSDper1k + (compT / 1000) * p.completionUSDper1k;

  const breakdown: CostEstimate['breakdown'] = [];
  const add = (label: string, calls: number, lowPer: number, highPer: number) => {
    if (calls > 0) breakdown.push({ label, calls, low: calls * lowPer, high: calls * highPer });
  };

  if (N0 > 1) add('Population fill (mutations)', (N0 - 1) * 2, per(svc, svcPromptTok, 200), per(svc, svcPromptTok, maxOut));
  add('Candidate evaluations', nodes * F * S, per(cand, candPromptTok, 100), per(cand, candPromptTok, maxOut));
  add('LLM grading', nodes * L * S, per(svc, judgePromptTok, 80), per(svc, judgePromptTok, 250));

  const guardrails = config.fitness.guardrails ?? [];
  if (config.fitness.weights.safety && guardrails.length > 0) {
    add('Safety guardrails', nodes * guardrails.length, per(svc, judgePromptTok, 80), per(svc, judgePromptTok, 250));
  }
  if (config.fitness.weights.stability) {
    add('Stability re-runs', nodes * 3, per(cand, candPromptTok, 100), per(cand, candPromptTok, maxOut));
  }

  // Operator service calls per transition: children split by normalized shares
  const shares = new Map<string, number>([
    ['mutation', config.operators.mutationShare || 0],
    ['crossover', config.operators.crossoverShare || 0],
    ['meta', config.operators.metaPrompting?.enabled ? (config.operators.metaPrompting.share || 0) : 0],
    ['param', config.operators.paramVariation?.enabled ? (config.operators.paramVariation.share || 0) : 0],
    ['model', config.operators.modelVariation?.enabled ? (config.operators.modelVariation.share || 0) : 0],
  ]);
  let pluginShare = 0;
  for (const [name, entry] of Object.entries(config.operators.custom ?? {})) {
    const s = (entry as any)?.share || 0;
    if (s > 0 && !shares.has(name)) pluginShare += s;
    if (s > 0 && shares.has(name)) shares.set(name, s); // custom may override built-ins
  }
  if (pluginShare > 0) warnings.push('plugin operators estimated at 0 LLM calls (their spend is unknown)');
  const CALLS_PER_CHILD: Record<string, number> = { mutation: 2, crossover: 1, meta: 2, param: 0, model: 0 };
  const totalShare = [...shares.values()].reduce((a, b) => a + b, 0) + pluginShare;
  let operatorCalls = 0;
  if (totalShare > 0) {
    const children = N - E;
    for (const [name, share] of shares) {
      operatorCalls += Math.round((share / totalShare) * children) * (CALLS_PER_CHILD[name] ?? 0);
    }
    operatorCalls *= transitions;
  }
  add('Genetic operators', operatorCalls, per(svc, svcPromptTok, 200), per(svc, svcPromptTok, maxOut));

  if (config.pairwise?.enabled && L > 0) {
    const c = Math.min(Math.max(Math.floor(config.pairwise.contenders ?? 4), 2), 8);
    const contenders = Math.min(c, N);
    const pairs = (contenders * (contenders - 1)) / 2;
    add('Pairwise playoffs', G * pairs * L * 2, per(svc, judgePromptTok, 80), per(svc, judgePromptTok, 250));
  }

  if (H > 0) {
    add('Holdout evaluation', 2 * H * S, per(cand, candPromptTok, 100), per(cand, candPromptTok, maxOut));
    if (Hllm > 0) add('Holdout grading', 2 * Hllm * S, per(svc, judgePromptTok, 80), per(svc, judgePromptTok, 250));
  }

  const calls = breakdown.reduce((a, b) => a + b.calls, 0);
  const low = breakdown.reduce((a, b) => a + b.low, 0);
  const high = breakdown.reduce((a, b) => a + b.high, 0);

  if (config.targets.budgetUSD !== undefined && config.targets.budgetUSD < low) {
    warnings.push(`budgetUSD ($${config.targets.budgetUSD}) is below the low estimate — the run will likely stop early`);
  }
  warnings.push('cache hits and early stops reduce actual spend');

  return { calls, low, high, perGeneration, breakdown, warnings };
}
```

- [ ] **Step 4: Exports** — `packages/core/src/index.ts`: `export { estimateRunCost } from './engine/estimate.js';`, `export type { CostEstimate } from './engine/estimate.js';`; grep for `getModelCost` in index.ts and add `export { getModelCost } from './providers/costs.js';` if absent.

- [ ] **Step 5: Run** — estimate tests green; full suite; bare type-check. (If the baseline hand-count fails, re-derive by printing `e.breakdown` — the arithmetic is the deliverable; fix the CODE unless the hand count itself was wrong, and document which.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/estimate.ts packages/core/src/index.ts packages/core/tests/engine/estimate.test.ts
git commit -m "estimateRunCost: preflight call/cost model with honest low-high band"
```

---

### Task 2: CLI banner + --estimate

**Files:**
- Modify: `packages/cli/src/engine.ts` (banner in the fresh-run else branch, after the Budget line)
- Modify: `packages/cli/src/index.ts` (`--estimate` flag + `handleEstimate`)
- Modify: `docs/cli.md`, `.claude/skills/evolving-prompts/SKILL.md`

**Interfaces:**
- Consumes: `estimateRunCost`, `getModelCost` from `@promptengine/core` (Task 1).

- [ ] **Step 1: Banner** — in `runEvolution`'s fresh-run branch (right after the `Budget:` stderr line, before the blank-line write):

```ts
    try {
      const { estimateRunCost, getModelCost } = await import('@promptengine/core');
      const est = await estimateRunCost(config, getModelCost);
      const scope = est.perGeneration ? ' per generation' : '';
      process.stderr.write(`Estimated cost${scope}: $${est.low.toFixed(4)} – $${est.high.toFixed(4)} (~${est.calls} calls)\n`);
      for (const w of est.warnings) process.stderr.write(`  note: ${w}\n`);
    } catch (err: any) {
      process.stderr.write(`Cost estimate unavailable: ${err.message}\n`);
    }
```

- [ ] **Step 2: `--estimate` flag** — parse-args: `estimate: false` boolean + return type `estimate: boolean;` + `case '--estimate': result.estimate = true; break;`; help line under `--report`: `  --estimate                   Print the cost estimate for --config and exit (no run)`. Dispatch in `main()` BEFORE the resume/config branches:

```ts
  if (args.estimate) {
    if (!args.config) { console.error('--estimate requires --config'); process.exit(1); }
    await handleEstimate(args.config, args.db);
    return;
  }
```

Handler (near handleRunEvolution; mirrors its setup, starts nothing):

```ts
async function handleEstimate(configPath: string, dbPath?: string): Promise<void> {
  const cliConfig = loadCliConfig(configPath);
  installStoreShim(extractConfigKeys(cliConfig), cliConfig.systemPrompts);
  await initCliDatabase(dbPath);
  const pathMod = await import('path');
  const configDir = pathMod.dirname(pathMod.resolve(configPath));
  const evalConfig = toEvaluationConfig(cliConfig, configDir);
  const { estimateRunCost, getModelCost, closeDatabase } = await import('@promptengine/core');
  const est = await estimateRunCost(evalConfig, getModelCost);

  // Human breakdown to stderr, machine JSON to stdout (CLI contract)
  const scope = est.perGeneration ? ' per generation' : '';
  process.stderr.write(`Estimated cost${scope}: $${est.low.toFixed(4)} – $${est.high.toFixed(4)} (~${est.calls} calls)\n`);
  for (const b of est.breakdown) {
    process.stderr.write(`  ${b.label.padEnd(28)} ${String(b.calls).padStart(5)} calls  $${b.low.toFixed(4)} – $${b.high.toFixed(4)}\n`);
  }
  for (const w of est.warnings) process.stderr.write(`  note: ${w}\n`);
  console.log(JSON.stringify(est, null, 2));
  closeDatabase();
}
```

- [ ] **Step 3: Docs** — `docs/cli.md` usage block: `npm run cli -- --estimate --config <path>       # Print the cost estimate and exit (no run, no spend)`; short "Cost estimation" paragraph after the usage block: the band brackets unknown completion lengths; every run also prints the estimate at startup; treat `high` as the commit number. SKILL.md bullet after the seed bullet: `- Budget matters? \`--estimate --config cfg.json\` prints the cost band + call count WITHOUT running (JSON on stdout). Treat \`high\` as the commit number; the startup banner shows the same estimate on real runs.`

- [ ] **Step 4: Run** — full suite; bare type-check; quick manual: `npm run cli -- --estimate --config <any scratch config> --db <scratch db>` prints JSON and exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/engine.ts packages/cli/src/index.ts docs/cli.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI: startup cost banner and --estimate dry run"
```

---

### Task 3: Desktop live estimate

**Files:**
- Modify: `apps/desktop/electron/ipc/handlers.ts` (`eval:estimate`)
- Modify: `apps/desktop/electron/preload.ts` (`estimate:` next to `getConfig:`)
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (footer line)
- Modify: the renderer's electronAPI type declaration (find via `grep -rn "getConfig" apps/desktop/src --include=*.d.ts` or the `window.electronAPI` interface file) — add `estimate(config: EvaluationConfig): Promise<CostEstimate | null>`
- Test: `apps/desktop/tests/ipc/handlers.test.ts` (extend)

- [ ] **Step 1: Failing handler test** — in the handlers test, after the existing CRUD test:

```ts
  it('eval:estimate returns a cost estimate without creating a run', async () => {
    const before = (await invoke('eval:list')).length;
    const est = await invoke('eval:estimate', makeConfig('cfg-est'));
    expect(est.calls).toBeGreaterThan(0);
    expect(est.low).toBeLessThanOrEqual(est.high);
    expect(Array.isArray(est.breakdown)).toBe(true);
    expect((await invoke('eval:list')).length).toBe(before); // no run row
  });
```

- [ ] **Step 2: Implement** — handlers.ts (with the other eval handlers):

```ts
  ipcMain.handle('eval:estimate', async (_event, config: EvaluationConfig) => {
    try {
      const { estimateRunCost, getModelCost } = await import('@promptengine/core');
      return await estimateRunCost(config, getModelCost);
    } catch (error) {
      console.error('[IPC] eval:estimate failed:', error);
      return null;
    }
  });
```

preload.ts: `estimate: (config) => ipcRenderer.invoke('eval:estimate', config),` after `getConfig`. Type declaration: add the method to the electronAPI eval interface.

- [ ] **Step 3: Modal footer** — in NewEvaluationModal, alongside existing state:

```tsx
  const [estimate, setEstimate] = useState<any>(null);
  useEffect(() => {
    if (!config.enabledModels?.length || !config.testSet?.length) { setEstimate(null); return; }
    const t = setTimeout(async () => {
      try { setEstimate(await window.electronAPI.eval.estimate(config as EvaluationConfig)); }
      catch { setEstimate(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [config]);
```

and in the footer div (`flex justify-between border-t pt-4`, between Cancel and Start — adjust to a three-item layout):

```tsx
          {estimate && (
            <span className="text-xs text-muted-foreground self-center" title={estimate.warnings?.join('\n')}>
              ≈ ${estimate.low.toFixed(4)} – ${estimate.high.toFixed(4)} · ~{estimate.calls} calls{estimate.perGeneration ? ' /gen' : ''}
            </span>
          )}
```

- [ ] **Step 4: Verify** — desktop tests green; bare type-check; rebuild `npm run build:dev -w apps/desktop`; CDP smoke: open New Evaluation (the default config has models+tests) → footer shows `≈ $`; read the displayed band, set `samplesPerTest` to 3 via the Service-tab input, wait ~1s, band's call count strictly increases. Kill electron.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/ipc/handlers.ts apps/desktop/electron/preload.ts apps/desktop/src/components/NewEvaluationModal.tsx apps/desktop/tests/ipc/handlers.test.ts <type-decl-file>
git commit -m "Desktop: live preflight cost estimate in the evaluation modal"
```

---

### Task 4: Live calibration

**Files:** none committed (scratchpad only).

- [ ] **Step 1**: Reuse the seed-live config shape (flash-lite, 3 tests incl. 1 llm_grade, populationSize 3, generationSize 3, maxGenerations 2, seed 42). First `--estimate --config ... --db <fresh scratch db copied from the shared catalog DB so prices resolve>` — capture `{low, high, calls}` from stdout JSON.
- [ ] **Step 2**: Run the same config for real (same db, `--output`). Compare: actual `totals.usd` ∈ `[low × 0.5, high]`; actual `totals.calls` within ±30% of estimated `calls`. Report the four numbers regardless of pass/fail.
- [ ] **Step 3**: Outside the band → STOP, diagnose which breakdown row diverged (compare per-phase counts against the run's log), fix constants or call model, re-run calibration once.
