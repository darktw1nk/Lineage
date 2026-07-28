# Pairwise Playoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pairwise playoff among each generation's top contenders — judged on stored outputs with both-orders position-bias cancellation — decides selection order, the elite, and the champion, with every judge call accounted in run totals and budget.

**Architecture:** New pure-ish module `pairwise.ts` runs a Copeland round-robin over stored `TestResult.outputText`s via the service model; the evaluator calls a deduplicating `maybeRunPlayoff` before selection in `moveToNextGeneration` AND at the start of `finishEvaluation` (the final generation never reaches moveToNextGeneration); `playoffRank` lands on node metrics and reorders `selectTopPerformers` + elitism + champion resolution. Absolute fitness is untouched.

**Tech Stack:** existing stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-pairwise-playoff-design.md` — normative, especially the "Cost accounting (hard requirement)" section.

## Global Constraints

- Commit messages: NEVER add `Co-Authored-By` or any attribution trailer; stage exact paths only (never `git add -A`).
- ESM, `.js` import suffixes; core never imports electron; strict TS stays green (`npm run type-check`) and the full suite green (`npx vitest run`) after every task.
- Defaults locked by spec: `pairwise.enabled` opt-in; `contenders` default 4 clamped 2..8 (warn on clamp); judge temperature 0.3; disagreement/tie/unparseable → 0.5 points each; ranking = Copeland points desc → absolute fitness desc → stable order.
- Cost accounting hard requirement: every judge call accrues usd/promptTokens/completionTokens + one `calls` increment to `state.run.totals` immediately with a `totals` event; spend counts against `budgetUSD`; `shouldAbort` checked between pairs.
- Work on branch `pairwise-playoff` off `master`.

---

### Task 1: Types + pairwise module

**Files:**
- Modify: `packages/core/src/types.ts` (three additions)
- Create: `packages/core/src/engine/pairwise.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/tests/engine/pairwise.test.ts`

**Interfaces:**
- Produces:
  - `CandidateNode.metrics` gains `playoffRank?: number;` (after `fitness`).
  - `EvaluationConfig` gains `pairwise?: { enabled: boolean; contenders?: number };` (after `holdoutSeed`).
  - `EvaluationRun` gains `playoffs?: Array<{ generation: number; ranking: UUID[] }>;` (after `holdout`).
  - `runPairwisePlayoff(opts: PlayoffOptions): Promise<PlayoffResult | null>` where:
    ```ts
    export interface PlayoffOptions {
      contenders: CandidateNode[];
      tests: TestCase[];
      config: EvaluationConfig;
      accrue: (usd: number, promptTokens: number, completionTokens: number) => void;
      shouldAbort?: () => boolean;
    }
    export interface PlayoffResult {
      ranking: UUID[];
      points: Record<UUID, number>;
      matches: number; // judge calls made
    }
    ```

- [ ] **Step 1: Write the failing tests** — `packages/core/tests/engine/pairwise.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { runPairwisePlayoff } from '../../src/engine/pairwise.js';
import type { CandidateNode, TestCase, EvaluationConfig } from '../../src/types.js';

// Scripted judge: the test sets `verdictFn` per scenario.
let verdictFn: (outputA: string, outputB: string) => 'A' | 'B' | 'tie';
let judgeCalls = 0;

function registerJudge(wrap: (json: string) => string = s => s) {
  registerProvider({
    adapter: {
      name: 'fakejudge',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        judgeCalls++;
        const a = opts.prompt.match(/OUTPUT A: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
        const b = opts.prompt.match(/OUTPUT B: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
        const winner = verdictFn(a, b);
        return {
          output: wrap(JSON.stringify({ winner, reason: 'scripted' })),
          promptTokens: 5, completionTokens: 3, latencyMs: 1, usd: 0.001,
        };
      },
    } as any,
  });
}

const test1: TestCase = { id: 't1', name: 't1', mode: 'llm_grade', prompt: 'INPUT', expected: 'REF' } as TestCase;

function contender(id: string, fitness: number, output: string): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished',
    prompt: 'p-' + id,
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [],
    metrics: { fitness, quality: fitness },
    tests: [{ testId: 't1', passed: true, score: fitness, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: output }],
  } as CandidateNode;
}

const config = {
  serviceModel: { provider: 'fakejudge', model: 'j1' },
  serviceModelMaxTokens: 100, retries: 1,
  targets: {},
} as unknown as EvaluationConfig;

let accrued: Array<[number, number, number]>;
const accrue = (usd: number, pt: number, ct: number) => accrued.push([usd, pt, ct]);

beforeEach(() => { resetRegistry(); judgeCalls = 0; accrued = []; });

describe('runPairwisePlayoff', () => {
  it('agreement in both orders gives the winner a full point', async () => {
    registerJudge();
    verdictFn = (a, b) => (a.includes('GOOD') ? 'A' : b.includes('GOOD') ? 'B' : 'tie');
    const nodes = [contender('n1', 9, 'GOOD output'), contender('n2', 9.5, 'plain output')];
    const result = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(result!.ranking[0]).toBe('n1'); // playoff beats higher fitness
    expect(result!.points['n1']).toBe(1);
    expect(result!.points['n2']).toBe(0);
    expect(result!.matches).toBe(2); // one pair × one test × two orders
    expect(accrued).toHaveLength(2); // accrue once per judge call
  });

  it('a position-biased judge (always picks first shown) yields a tie', async () => {
    registerJudge();
    verdictFn = () => 'A'; // always the first-presented output
    const nodes = [contender('n1', 9, 'x'), contender('n2', 8, 'y')];
    const result = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(result!.points['n1']).toBe(0.5);
    expect(result!.points['n2']).toBe(0.5);
    expect(result!.ranking[0]).toBe('n1'); // fitness tiebreak
  });

  it('parses fenced verdict JSON and treats junk as tie', async () => {
    registerJudge(s => '```json\n' + s + '\n```');
    verdictFn = (a) => (a.includes('GOOD') ? 'A' : 'B');
    const nodes = [contender('n1', 9, 'GOOD'), contender('n2', 8, 'bad')];
    const fenced = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(fenced!.points['n1']).toBe(1);

    resetRegistry();
    registerProvider({ adapter: { name: 'fakejudge', estimateTokens: () => ({ prompt: 1 }),
      call: async () => ({ output: 'NOT JSON AT ALL', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }) } as any });
    const junk = await runPairwisePlayoff({ contenders: nodes, tests: [test1], config, accrue });
    expect(junk!.points['n1']).toBe(0.5); // all verdicts unparseable → ties
  });

  it('skips pair-tests where a contender lacks outputText', async () => {
    registerJudge();
    verdictFn = () => 'A';
    const noOutput = contender('n2', 8, '');
    noOutput.tests![0].outputText = undefined;
    const result = await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x'), noOutput], tests: [test1], config, accrue });
    expect(result!.matches).toBe(0);
    expect(result!.points['n1']).toBe(0);
  });

  it('shouldAbort between pairs abandons remaining matches', async () => {
    registerJudge();
    verdictFn = () => 'tie';
    let aborted = false;
    const nodes = [contender('n1', 9, 'a'), contender('n2', 8, 'b'), contender('n3', 7, 'c')]; // 3 pairs
    const result = await runPairwisePlayoff({
      contenders: nodes, tests: [test1], config, accrue,
      shouldAbort: () => { const v = aborted; aborted = true; return v; }, // false for pair 1, true after
    });
    expect(result!.matches).toBe(2); // only the first pair ran (2 orders)
  });

  it('returns null for fewer than 2 contenders or no tests', async () => {
    registerJudge();
    verdictFn = () => 'tie';
    expect(await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x')], tests: [test1], config, accrue })).toBeNull();
    expect(await runPairwisePlayoff({ contenders: [contender('n1', 9, 'x'), contender('n2', 8, 'y')], tests: [], config, accrue })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

Run: `npx vitest run --project @promptengine/core packages/core/tests/engine/pairwise.test.ts`

- [ ] **Step 3: Type additions** (three small edits in `types.ts` exactly as in Interfaces).

- [ ] **Step 4: Create `packages/core/src/engine/pairwise.ts`**:

```ts
/**
 * Pairwise playoff: round-robin comparison of top contenders' STORED outputs,
 * judged by the service model in BOTH orders per pair to cancel position bias.
 * Produces a Copeland ranking used to sharpen selection/elite/champion.
 * Absolute fitness is not modified.
 */
import type { CandidateNode, TestCase, EvaluationConfig, UUID } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';

export interface PlayoffOptions {
  contenders: CandidateNode[];
  tests: TestCase[];
  config: EvaluationConfig;
  accrue: (usd: number, promptTokens: number, completionTokens: number) => void;
  shouldAbort?: () => boolean;
}

export interface PlayoffResult {
  ranking: UUID[];
  points: Record<UUID, number>;
  matches: number;
}

const DEFAULT_PAIRWISE_JUDGING_PROMPT = `SYSTEM: You compare two candidate outputs for the same task. Return ONLY a JSON object.
USER: TASK INPUT: <<<
\${testPrompt}
>>>
\${expectedBlock}OUTPUT A: <<<
\${outputA}
>>>
OUTPUT B: <<<
\${outputB}
>>>

Which output better fulfils the task (accuracy, format, faithfulness to any reference, clarity)?
Return: {"winner": "A" | "B" | "tie", "reason": "<one sentence>"}`;

function getPairwiseTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts?.pairwiseJudgingPrompt) return prompts.pairwiseJudgingPrompt;
  } catch { /* fall through */ }
  return DEFAULT_PAIRWISE_JUDGING_PROMPT;
}

function parseVerdict(raw: string): 'A' | 'B' | 'tie' {
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(text);
    const winner = String(parsed.winner ?? '').toLowerCase();
    if (winner === 'a') return 'A';
    if (winner === 'b') return 'B';
    if (winner === 'tie') return 'tie';
  } catch { /* fall through */ }
  console.warn('[Playoff] Unparseable verdict, counting as tie:', raw.slice(0, 120));
  return 'tie';
}

function outputFor(node: CandidateNode, testId: string): string | undefined {
  const text = node.tests?.find(t => t.testId === testId)?.outputText;
  return text && text.length > 0 ? text : undefined;
}

export async function runPairwisePlayoff(opts: PlayoffOptions): Promise<PlayoffResult | null> {
  const { contenders, tests, config, accrue, shouldAbort } = opts;
  if (contenders.length < 2 || tests.length === 0) return null;

  const adapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  const template = getPairwiseTemplate();
  const points: Record<UUID, number> = Object.fromEntries(contenders.map(c => [c.id, 0]));
  let matches = 0;

  const judge = async (test: TestCase, first: string, second: string): Promise<'A' | 'B' | 'tie'> => {
    const expectedBlock = test.expected ? `EXPECTED (reference): <<<\n${test.expected}\n>>>\n` : '';
    const prompt = template
      .replace(/\$\{testPrompt\}/g, test.prompt)
      .replace(/\$\{expectedBlock\}/g, expectedBlock)
      .replace(/\$\{outputA\}/g, first)
      .replace(/\$\{outputB\}/g, second);
    try {
      const result = await adapter.call({ model: config.serviceModel.model, prompt, temperature: 0.3, maxTokens });
      matches++;
      accrue(result.usd || 0, result.promptTokens || 0, result.completionTokens || 0);
      return parseVerdict(result.output);
    } catch (error) {
      matches++;
      console.error('[Playoff] Judge call failed, counting as tie:', error instanceof Error ? error.message : error);
      return 'tie';
    }
  };

  outer:
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      if (shouldAbort?.()) {
        console.warn('[Playoff] Aborted between pairs (budget) — ranking from completed matches');
        break outer;
      }
      const a = contenders[i];
      const b = contenders[j];
      for (const test of tests) {
        const outA = outputFor(a, test.id);
        const outB = outputFor(b, test.id);
        if (!outA || !outB) continue;

        // Order 1: a first. Order 2: b first — map verdicts back to nodes.
        const v1 = await judge(test, outA, outB); // 'A' → a, 'B' → b
        const v2 = await judge(test, outB, outA); // 'A' → b, 'B' → a
        const w1 = v1 === 'A' ? a.id : v1 === 'B' ? b.id : null;
        const w2 = v2 === 'A' ? b.id : v2 === 'B' ? a.id : null;

        if (w1 && w1 === w2) {
          points[w1] += 1; // both orders agree
        } else {
          points[a.id] += 0.5;
          points[b.id] += 0.5;
        }
      }
    }
  }

  const ranking = [...contenders]
    .sort((x, y) =>
      (points[y.id] - points[x.id]) ||
      ((y.metrics?.fitness ?? 0) - (x.metrics?.fitness ?? 0)))
    .map(c => c.id);

  return { ranking, points, matches };
}
```

- [ ] **Step 5: Export** — `packages/core/src/index.ts`: `export { runPairwisePlayoff } from './engine/pairwise.js';` and `export type { PlayoffOptions, PlayoffResult } from './engine/pairwise.js';`

- [ ] **Step 6: Run tests** — pairwise tests PASS; full suite green; type-check clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/engine/pairwise.ts packages/core/src/index.ts packages/core/tests/engine/pairwise.test.ts
git commit -m "Add pairwise playoff module with both-orders bias cancellation"
```

---

### Task 2: Engine integration — maybeRunPlayoff, selection, elite, champion

**Files:**
- Modify: `packages/core/src/engine/evaluator_v2.ts` (state fields, `maybeRunPlayoff`, two hook sites, champion resolution)
- Modify: `packages/core/src/engine/generation.ts` (rank-aware sorts in `selectTopPerformers` + elite pick; elite clone sheds rank)
- Test: `packages/core/tests/engine/pairwise-e2e.test.ts` (new)

**Interfaces:**
- Consumes: `runPairwisePlayoff` (Task 1).
- Produces: `EvaluationState` gains `pairwiseEnabled: boolean; pairwiseContenders: number;`; event `{ type: 'playoff_result', generation, ranking, matches }`; `state.run.playoffs` populated; champion resolution honors latest playoff rank 1.

- [ ] **Step 1: Write the failing E2E test** — `packages/core/tests/engine/pairwise-e2e.test.ts` (fidelity-test harness style):

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

import { selectTopPerformers } from '../../src/engine/generation.js';

let promptCounter = 0;
let adapterCalls = 0;
let judgeCalls = 0;

// One fake provider serving ALL roles, discriminated by prompt content:
// - mutation proposal → edits JSON
// - mutation apply → unique variant prompt text
// - candidate eval (system present) → echoes the candidate prompt (system)
// - grading rubric → SEED-containing outputs score 8, others 9 (fitness favors variants)
// - pairwise verdict → the side containing 'SEED' wins (playoff favors the seed)
function registerOmniAdapter() {
  registerProvider({
    adapter: {
      name: 'omni',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        adapterCalls++;
        const base = { promptTokens: 4, completionTokens: 2, latencyMs: 1, usd: 0.0001 };
        const p: string = opts.prompt;
        if (p.includes('"winner"')) {
          judgeCalls++;
          const a = p.match(/OUTPUT A: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
          const b = p.match(/OUTPUT B: <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
          const winner = a.includes('SEED') ? 'A' : b.includes('SEED') ? 'B' : 'tie';
          return { ...base, output: JSON.stringify({ winner, reason: 's' }) };
        }
        if (p.includes('Rubric')) {
          const out = p.match(/OUTPUT \(model\): <<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
          return { ...base, output: JSON.stringify({ score: out.includes('SEED') ? 8 : 9, justification: 's' }) };
        }
        if (p.includes('mutations to improve')) {
          return { ...base, output: '[{"label":"MUTATION","edit":"tweak"}]' };
        }
        if (p.includes('Produce the NEW prompt ONLY')) {
          return { ...base, output: `VARIANT PROMPT ${++promptCounter}` };
        }
        // Candidate evaluation: echo the candidate (system) prompt as the output
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig() {
  return {
    id: 'pw-cfg', name: 'pairwise e2e',
    selection: { policy: 'topk', topK: 2, eliteShare: 0.2 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 3, generationSize: 3, seedPrompt: 'SEED PROMPT ALPHA', fill: 'auto' },
    enabledModels: [{ provider: 'omni', model: 'm1' }],
    testSet: [
      { id: 't1', name: 'graded', mode: 'llm_grade', prompt: 'THE INPUT', expected: 'REF' },
      // Holdout: candidate calls echo the system prompt, so only the SEED champion scores 10 here
      { id: 'h1', name: 'held out', mode: 'exact_match', prompt: 'HOLD INPUT', expected: 'SEED PROMPT ALPHA', holdout: true },
    ],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'omni', model: 'm1' },
    parallelLimit: 2, serviceModelMaxTokens: 200, retries: 1,
    pairwise: { enabled: true, contenders: 3 },
  } as any;
}

beforeEach(() => { resetRegistry(); promptCounter = 0; adapterCalls = 0; judgeCalls = 0; });

describe('pairwise playoff end-to-end', () => {
  it('playoff winner becomes elite and champion despite lower absolute fitness', async () => {
    registerOmniAdapter();
    const config = makeConfig();
    const tmpDb = path.join(os.tmpdir(), `pe-pw-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    await initializeDatabase(tmpDb);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(config.id, config.name, JSON.stringify(config), Date.now());
    const run: any = {
      id: 'pw-run', configId: config.id, startedAt: Date.now(),
      totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
      generations: [], cacheHits: 0, version: '1.0',
    };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    const events: any[] = [];
    // Deep-snapshot every event: the engine mutates node objects AFTER emitting them
    // (the gen-1 playoff stamps ranks onto the same references), and assertions below
    // need event-time state.
    const done = new Promise<void>(res => setSendUpdate((_id, data) => {
      events.push(JSON.parse(JSON.stringify(data)));
      if (data.type === 'status' && data.status === 'finished') res();
    }));
    await startEvaluation(run.id, config, run);
    await done;

    // Playoffs ran for BOTH generations: gen 0 via moveToNextGeneration, gen 1 via finishEvaluation
    const playoffEvents = events.filter(e => e.type === 'playoff_result');
    expect(playoffEvents.map(e => e.generation)).toEqual([0, 1]);

    // Cost accounting (spec hard requirement): every judge call audited and accrued.
    // matches in playoff_result must equal real judge calls; final totals must count
    // EVERY adapter call including playoff judges (one calls-increment per call).
    expect(judgeCalls).toBeGreaterThan(0);
    expect(playoffEvents.reduce((s, e) => s + e.matches, 0)).toBe(judgeCalls);
    const totalsEvents = events.filter(e => e.type === 'totals');
    expect(totalsEvents[totalsEvents.length - 1].totals.calls).toBe(adapterCalls);

    // Seed won the gen-0 playoff despite its lower absolute score (8 vs 9)
    const nodes = events.filter(e => e.node).map(e => e.node);
    const gen0Seed = nodes.find(n => n.generation === 0 && n.prompt === 'SEED PROMPT ALPHA' && n.metrics?.playoffRank === 1);
    expect(gen0Seed).toBeDefined();

    // Elite carried into gen 1 is the playoff winner (the seed), not the higher-fitness variant,
    // and the clone shed the stale rank (first snapshot of it, before the gen-1 playoff re-ranks)
    const allNodes = [...nodes, ...events.filter(e => Array.isArray(e.nodes)).flatMap(e => e.nodes)];
    const gen1Elite = allNodes.find(n => n.generation === 1 && n.changeLog?.[0]?.label === 'ELITE');
    expect(gen1Elite.prompt).toBe('SEED PROMPT ALPHA');
    expect(gen1Elite.metrics?.playoffRank).toBeUndefined();

    // Holdout evaluates the PLAYOFF winner as champion: only the seed echoes 'SEED PROMPT ALPHA'
    const holdoutEvent = events.find(e => e.type === 'holdout_result');
    expect(holdoutEvent.holdout.champion.score).toBeCloseTo(10, 5);

    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
    setSendUpdate(() => {});
  }, 30000);
});

describe('selectTopPerformers is playoff-rank aware', () => {
  const mk = (id: string, fitness: number, playoffRank?: number) => ({
    id, generation: 0, status: 'finished', prompt: id, lineageParents: [], changeLog: [],
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    metrics: { fitness, quality: fitness, ...(playoffRank ? { playoffRank } : {}) },
  }) as any;

  it('rank 1 outranks higher raw fitness; unranked follow by fitness', () => {
    const gen = [mk('hi-fit', 9.9), mk('winner', 9.7, 1), mk('second', 9.8, 2)];
    const top = selectTopPerformers(gen, { selection: { policy: 'topk', topK: 3 } } as any);
    expect(top.map((n: any) => n.id)).toEqual(['winner', 'second', 'hi-fit']);
  });
});
```

- [ ] **Step 2: Run to verify failure** — no `playoff_result` events, no playoffRank.

- [ ] **Step 3: Evaluator changes**

Deviation note: the spec mentions `state.lastPlayoff` — it is intentionally subsumed by `state.run.playoffs`, which serves both the dedupe guard and champion resolution. Do NOT add a separate `lastPlayoff` field.

3a. `EvaluationState` gains (after `promptMode`):
```ts
  pairwiseEnabled: boolean;
  pairwiseContenders: number;
```
3b. In `startEvaluation`, after the holdout resolution block:
```ts
  const pairwiseEnabled = config.pairwise?.enabled === true;
  const rawContenders = config.pairwise?.contenders ?? 4;
  const pairwiseContenders = Math.min(Math.max(Math.floor(rawContenders), 2), 8);
  if (pairwiseEnabled && pairwiseContenders !== rawContenders) {
    console.warn(`[Playoff] contenders clamped from ${rawContenders} to ${pairwiseContenders}`);
  }
```
and `pairwiseEnabled, pairwiseContenders,` in the state literal.

3c. Add above `moveToNextGeneration`:
```ts
async function maybeRunPlayoff(runId: UUID, state: EvaluationState): Promise<void> {
  if (!state.pairwiseEnabled) return;
  const genIndex = state.currentGeneration;
  if (state.run.playoffs?.some(p => p.generation === genIndex)) return;
  const llmTests = state.fitnessTests.filter(t => t.mode === 'llm_grade');
  if (llmTests.length === 0) return;

  const gen = state.run.generations[genIndex] || [];
  const finished = gen
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!);
  const contenders = finished.slice(0, state.pairwiseContenders);
  if (contenders.length < 2) return;

  const budget = state.config.targets.budgetUSD;
  if (budget && state.run.totals.usd >= budget) {
    console.warn('[Playoff] Budget exhausted — skipping playoff');
    return;
  }

  const { runPairwisePlayoff } = await import('./pairwise.js');
  const result = await runPairwisePlayoff({
    contenders,
    tests: llmTests,
    config: state.config,
    accrue: (usd, promptTokens, completionTokens) => {
      state.run.totals.usd += usd;
      state.run.totals.tokensPrompt += promptTokens;
      state.run.totals.tokensCompletion += completionTokens;
      state.run.totals.calls++;
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    },
    shouldAbort: () => !!(budget && state.run.totals.usd >= budget),
  });
  if (!result) return;

  result.ranking.forEach((id, i) => {
    const node = contenders.find(n => n.id === id);
    if (node?.metrics) {
      node.metrics.playoffRank = i + 1;
      sendUpdate(runId, { type: 'node_updated', node });
    }
  });
  state.run.playoffs = [...(state.run.playoffs ?? []), { generation: genIndex, ranking: result.ranking }];
  sendUpdate(runId, { type: 'playoff_result', generation: genIndex, ranking: result.ranking, matches: result.matches });
  console.log(`[Playoff] Gen ${genIndex}: winner ${result.ranking[0].slice(0, 8)} (${result.matches} judge calls, ${result.ranking.length} contenders)`);
}
```
3d. Hook sites: in `moveToNextGeneration`, insert `await maybeRunPlayoff(runId, state);` immediately after `const currentGen = state.run.generations[state.currentGeneration];` (before `selectTopPerformers`). In `finishEvaluation`, insert `await maybeRunPlayoff(runId, state);` as the FIRST statement (before `runHoldoutEvaluation` — the champion pick below then sees the final generation's ranks).
3e. Champion resolution in `runHoldoutEvaluation` — replace the champion pick:
```ts
  const playoffChampionId = [...(state.run.playoffs ?? [])]
    .sort((a, b) => b.generation - a.generation)[0]?.ranking[0];
  const champion =
    (playoffChampionId ? finished.find(n => n.id === playoffChampionId) : undefined)
    ?? [...finished].sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!)[0];
```

- [ ] **Step 4: generation.ts changes**

4a. `selectTopPerformers` sort becomes:
```ts
    .sort((a, b) => {
      const ra = a.metrics?.playoffRank ?? Infinity;
      const rb = b.metrics?.playoffRank ?? Infinity;
      if (ra !== rb) return ra - rb;
      return b.metrics!.fitness! - a.metrics!.fitness!;
    });
```
4b. Elite pick sort (`lastGenFinishedNodes.sort(...)` in `createNextGeneration`) uses the identical comparator.
4c. Elite clone sheds the stale rank — in the elite clone construction:
```ts
      for (const elite of elites) {
        const { playoffRank: _stalePlayoffRank, ...eliteMetrics } = elite.metrics ?? {};
        const eliteClone: CandidateNode = {
          ...elite,
          id: uuidv4(),
          generation: nextGenerationNumber,
          status: 'finished',
          lineageParents: [elite.id],
          metrics: elite.metrics ? eliteMetrics : undefined,
          changeLog: [{ label: 'ELITE', text: `Elite from gen ${elite.generation} (fitness=${elite.metrics?.fitness?.toFixed(3)})` }],
        };
```
(keep the `_operatorType`/`_parentFitness` lines that follow).

- [ ] **Step 5: Run tests** — E2E passes; existing suites (generation tests, fidelity, plugin-dispatch) stay green; type-check clean. `noUnusedLocals` note: the `_stalePlayoffRank` destructure — TS allows underscore-prefixed unused destructure only via `ignoreRestSiblings`-style rules NOT enabled here; if tsc complains, use `const eliteMetrics = { ...elite.metrics }; delete eliteMetrics.playoffRank;` instead.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/evaluator_v2.ts packages/core/src/engine/generation.ts packages/core/tests/engine/pairwise-e2e.test.ts
git commit -m "Wire pairwise playoff into selection, elitism, and champion resolution"
```

---

### Task 3: CLI passthrough, collector, report, docs

**Files:**
- Modify: `packages/cli/src/config.ts`, `packages/cli/src/engine.ts`, `packages/cli/src/report.ts`
- Modify: `docs/cli.md`, `README.md`, `.claude/skills/evolving-prompts/SKILL.md`
- Test: `packages/cli/tests/config.test.ts` (addition)

**Interfaces:**
- Consumes: `playoff_result` event `{ generation, ranking, matches }`; `EvolutionResult` node `metrics.playoffRank`.
- Produces: `EvolutionResult.playoffs?: Array<{ generation: number; ranking: string[] }>`; `best` prefers the latest playoff winner.

- [ ] **Step 1: Failing config test** (append to `packages/cli/tests/config.test.ts`'s fidelity describe):

```ts
  it('passes pairwise config through', () => {
    const cfg = toEvaluationConfig({
      seedPrompt: 's', testSet: [{ prompt: 'p' }],
      pairwise: { enabled: true, contenders: 6 },
    } as any, '.');
    expect(cfg.pairwise).toEqual({ enabled: true, contenders: 6 });
  });
```

- [ ] **Step 2: Implement**

`config.ts`: `CliConfig` gains `pairwise?: { enabled: boolean; contenders?: number };`; in `toEvaluationConfig`'s return: `...(config.pairwise ? { pairwise: config.pairwise } : {}),`.

`engine.ts`:
- `EvolutionResult` gains `playoffs?: Array<{ generation: number; ranking: string[] }>;`
- Collector: `playoffs: [] as Array<{ generation: number; ranking: string[] }>` in `createCollector`; switch case:
```ts
      case 'playoff_result':
        collector.playoffs.push({ generation: data.generation, ranking: data.ranking });
        break;
```
- `buildResult`: include `...(collector.playoffs.length ? { playoffs: collector.playoffs } : {}),` and change the `best` computation: before the existing `const best = collector.bestNode;` add:
```ts
  // Champion: latest playoff winner when playoffs ran, else best-by-fitness
  let bestNode = collector.bestNode;
  const lastPlayoff = collector.playoffs[collector.playoffs.length - 1];
  if (lastPlayoff) {
    for (const nodesMap of collector.generations.values()) {
      const winner = nodesMap.get(lastPlayoff.ranking[0]);
      if (winner) { bestNode = winner; break; }
    }
  }
```
and use `bestNode` where `collector.bestNode` was used for `best`.

`report.ts`: in the "Best Evolved Prompt" section (after `lines.push('## Best Evolved Prompt');` at ~line 195), add:
```ts
  if (result.playoffs && result.playoffs.length > 0) {
    const lastPlayoff = result.playoffs[result.playoffs.length - 1];
    lines.push('');
    lines.push(`*Champion selected by pairwise playoff (${lastPlayoff.ranking.length} contenders, both-orders judging).*`);
  }
```

- [ ] **Step 3: Docs**

`docs/cli.md` "Evaluation fidelity" section, new bullet:
```markdown
- `"pairwise": { "enabled": true, "contenders": 4 }` runs a pairwise playoff among each generation's top candidates: their stored outputs are compared head-to-head by the judge in BOTH orders (position bias cancels), and the resulting rank decides selection, the elite, and the champion. Applies to llm_grade tests; judge calls count toward totals and the budget. Sharpened selection exactly where absolute 0-10 scores cluster.
```
`README.md` "The genetics" step 2 (Selects): append sentence: `Optionally, a **pairwise playoff** re-ranks the top contenders head-to-head (both presentation orders, position bias cancelled) — decisive exactly where absolute scores cluster at 9.8-vs-9.9.`
`.claude/skills/evolving-prompts/SKILL.md`: after the holdout line add: `- For llm_grade-heavy runs, enable "pairwise": { "enabled": true } — top contenders are re-ranked by head-to-head judging; the champion is the playoff winner, not the noisiest 9.9.`

- [ ] **Step 4: Run** — CLI suite + full suite green, type-check clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/engine.ts packages/cli/src/report.ts packages/cli/tests/config.test.ts docs/cli.md README.md .claude/skills/evolving-prompts/SKILL.md
git commit -m "CLI + docs: pairwise passthrough, playoff-aware champion, report note"
```

---

### Task 4: Desktop UI

**Files:**
- Modify: `apps/desktop/src/store/evaluationStore.ts` (no-op-safe `playoff_result` handling: merge `playoffs` onto the run)
- Modify: `apps/desktop/src/components/RightPanel.tsx` (playoff rank in Node Details)
- Modify: `apps/desktop/src/components/NewEvaluationModal.tsx` (pairwise toggle + contenders in the Service tab "Evaluation harness" section)
- Test: `apps/desktop/tests/store/evaluationStore.test.ts` (addition)

- [ ] **Step 1: Failing store test** (append near the holdout_result test):

```ts
  it('playoff_result appends to run.playoffs', () => {
    store().setEvaluation('run-1', makeRun('run-1'));
    store().subscribe('run-1');
    capturedCallbacks.get('run-1')!({}, { type: 'playoff_result', generation: 0, ranking: ['n2', 'n1'], matches: 6 });
    expect((store().evaluations.get('run-1') as any).playoffs).toEqual([{ generation: 0, ranking: ['n2', 'n1'] }]);
  });
```

- [ ] **Step 2: Implement**

`evaluationStore.ts`: interface gains `addPlayoff: (evalId: UUID, playoff: { generation: number; ranking: UUID[] }) => void;`; action (same immutable pattern):
```ts
  addPlayoff: (evalId, playoff) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, playoffs: [...(evaluation.playoffs ?? []), playoff] });
      return { evaluations: newEvaluations };
    });
  },
```
subscribe switch: `case 'playoff_result': store.addPlayoff(evalId, { generation: data.generation, ranking: data.ranking }); break;`

`RightPanel.tsx`: in the Node Details metrics block (anchor: `grep -n "Fitness:" apps/desktop/src/components/RightPanel.tsx` — the metrics grid rendering Quality/Cost/Latency/Fitness), add alongside the Fitness entry, following the block's existing markup pattern:
```tsx
{node.metrics?.playoffRank !== undefined && (
  <div>Playoff: <span className="font-medium">#{node.metrics.playoffRank}</span></div>
)}
```
(adapt tags/classes to the neighboring metric entries' exact structure).

`NewEvaluationModal.tsx`: in the "Evaluation harness" section (Service tab, added in the fidelity phase — anchor `grep -n "Evaluation harness"`), append after the holdoutShare input:
```tsx
        <div className="flex items-center space-x-2">
          <Switch
            id="pairwiseEnabled"
            checked={config.pairwise?.enabled || false}
            onCheckedChange={(checked) =>
              setConfig({ ...config, pairwise: { ...(config.pairwise ?? {}), enabled: checked } })
            }
          />
          <Label htmlFor="pairwiseEnabled" className="text-sm">
            Pairwise playoff (top contenders re-ranked head-to-head each generation)
          </Label>
        </div>

        {config.pairwise?.enabled && (
          <div>
            <LabelWithTooltip
              htmlFor="pairwiseContenders"
              label="Playoff Contenders"
              tooltip="How many top candidates enter the pairwise playoff each generation (2-8). Judge calls: contenders choose 2 × llm_grade tests × 2 orders."
            />
            <Input
              id="pairwiseContenders"
              type="number"
              min="2"
              max="8"
              value={config.pairwise?.contenders ?? 4}
              onChange={(e) => setConfig({ ...config, pairwise: { enabled: true, contenders: parseInt(e.target.value) || 4 } })}
            />
          </div>
        )}
```

- [ ] **Step 3: Verify** — desktop tests green; `npm run type-check` clean; boot smoke: rebuild (`npm run build:dev -w apps/desktop`), CDP-boot, open modal → Service tab, assert `#pairwiseEnabled` exists; kill electron.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/store/evaluationStore.ts apps/desktop/src/components/RightPanel.tsx apps/desktop/src/components/NewEvaluationModal.tsx apps/desktop/tests/store/evaluationStore.test.ts
git commit -m "Desktop: playoff rank display, pairwise config inputs"
```

---

### Task 5: Live verification run

**Files:** none committed (scratch config/results only).

- [ ] **Step 1**: Write scratch config to the session scratchpad (NOT the repo) as `pairwise-live.json`:

```json
{
  "seedPrompt": "Answer the user's question in one short sentence.",
  "models": [{ "provider": "gemini", "model": "gemini-2.5-flash-lite" }],
  "serviceModel": { "provider": "gemini", "model": "gemini-2.5-flash-lite" },
  "testSet": [
    { "prompt": "What is the capital of France?", "expected": "Paris", "mode": "llm_grade" },
    { "prompt": "What is 12 * 12?", "expected": "144", "mode": "llm_grade" },
    { "prompt": "Spell 'cat' backwards.", "expected": "tac", "mode": "exact_match" }
  ],
  "population": { "initialSize": 3, "generationSize": 3 },
  "maxGenerations": 2,
  "budgetUSD": 0.02,
  "pairwise": { "enabled": true, "contenders": 3 }
}
```

Run from repo root: `npm run cli -- --config <scratchpad>/pairwise-live.json --output <scratchpad>/pairwise-live-results.json --db <scratchpad>/pairwise-live.db` (adjust field names to actual CliConfig schema — check `packages/cli/src/config.ts` before writing the file).
- [ ] **Step 2**: Assert: exit 0; log shows `[Playoff] Gen N: winner …` lines; results.json has `playoffs` array and contender nodes carry `metrics.playoffRank`; run totals include the playoff judge calls (compare `totals.calls` against a no-playoff baseline run of the same config, or verify `playoff_result.matches > 0` and stderr totals grew during playoff); report contains the "Champion selected by pairwise playoff" note.
- [ ] **Step 3**: Report numbers; mismatch with spec → STOP and fix.
