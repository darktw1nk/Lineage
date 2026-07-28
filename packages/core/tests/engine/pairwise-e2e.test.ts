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
// - pairwise verdict -> the side containing 'SEED' wins (playoff favors the seed)
// - grading rubric -> SEED-containing outputs score 8, others 9 (fitness favors variants)
// - mutation proposal -> edits JSON; mutation apply -> unique variant prompt text
// - candidate eval (system present) -> echoes the candidate prompt (system)
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
    // and the clone shed the stale rank. Use the creation-time snapshot (generation_created):
    // the gen-1 playoff legitimately re-ranks the clone later via node_updated.
    const createdNodes = events.filter(e => Array.isArray(e.nodes)).flatMap(e => e.nodes);
    const gen1Elite = createdNodes.find(n => n.generation === 1 && n.changeLog?.[0]?.label === 'ELITE');
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
