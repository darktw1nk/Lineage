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
    // evals 10->30 (+20), grading 5->15 (+10); fill+operators unchanged
    expect(e3.calls).toBe(e1.calls + 30);
  });

  it('playoff adds pairs x L x 2 per generation', async () => {
    const e = await estimateRunCost(base({ pairwise: { enabled: true, contenders: 3 } }), flatCost);
    const noPlayoff = await estimateRunCost(base(), flatCost);
    // contenders min(3,3)=3 -> 3 pairs; L=1; G=2 -> 2*3*1*2 = 12
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

  it('safety adds per-node calls when weighted', async () => {
    const e = await estimateRunCost(base({
      fitness: { weights: { quality: 1, safety: 0.2 }, guardrails: ['no pii', 'no slang'] },
    }), flatCost);
    const plain = await estimateRunCost(base(), flatCost);
    expect(e.calls).toBe(plain.calls + 10); // nodes=5 x 2 guardrails
  });

  it('stability adds NO calls — it is read from samples already taken', async () => {
    // It used to add nodes*3 phantom calls, from when stability made its own
    // provider calls to measure reply-length variance. That was 108 of 338
    // calls in the docs' own example — a 32% over-count.
    const e = await estimateRunCost(base({
      fitness: { weights: { quality: 1, stability: 0.5 } },
    }), flatCost);
    const plain = await estimateRunCost(base(), flatCost);
    expect(e.calls).toBe(plain.calls);
  });

  it('unset maxGenerations => perGeneration estimate (one gen-0 pass + one transition)', async () => {
    const e = await estimateRunCost(base({ targets: {} }), flatCost);
    expect(e.perGeneration).toBe(true);
    expect(e.calls).toBeGreaterThan(0);
  });

  it('uncatalogued model warns and prices at zero', async () => {
    const e = await estimateRunCost(base(), noCost);
    expect(e.low).toBe(0);
    expect(e.warnings.some(w => w.includes('NOT PRICED'))).toBe(true);
    // One note per model, not one per price lookup.
    expect(e.warnings.filter(w => w.includes('NOT PRICED')).length).toBe(1);
  });

  it('says explicitly that an unpriced model makes budgetUSD unenforceable', async () => {
    // This is the single most consequential thing the preflight can say — the
    // calls are priced at $0, so the cap can never trip — and it used to be
    // one lowercase `note:` among five.
    const e = await estimateRunCost(base({ targets: { maxGenerations: 2, budgetUSD: 2 } }), noCost);
    const notice = e.warnings.find(w => w.includes('NOT PRICED'));
    expect(notice).toMatch(/CANNOT be enforced/);
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

describe('estimateRunCost matches what the engine will actually do', () => {
  it('partitions the holdout with the SAME seed the engine uses', async () => {
    // The engine uses `config.holdoutSeed ?? 42`, deliberately NOT coupled to
    // config.seed. Falling through config.seed here made the preview hold out
    // the exact complement of the run's real holdout: a config with `seed` set
    // previewed llm_grade fitness tests for a run whose fitness set had none.
    const withoutSeed = await estimateRunCost(base({ holdoutShare: 0.5, targets: { maxGenerations: 1 } }), flatCost);
    const withSeed = await estimateRunCost(base({ holdoutShare: 0.5, seed: 12345, targets: { maxGenerations: 1 } }), flatCost);
    expect(withSeed.calls).toBe(withoutSeed.calls);
    expect(withSeed.breakdown).toEqual(withoutSeed.breakdown);
  });

  it('keeps the operator line when eliteShare is near 1', async () => {
    // generation.ts clamps numElite to targetPopSize - 1. Without the same
    // clamp here, E === N made children === 0, so the whole operator line
    // vanished from the estimate while the engine still ran and billed it.
    const e = await estimateRunCost(base({ selection: { policy: 'topk', topK: 2, eliteShare: 1.0 } }), flatCost);
    const ops = e.breakdown.find(b => b.label === 'Genetic operators');
    expect(ops).toBeDefined();
    expect(ops!.calls).toBeGreaterThan(0);
  });

  it('sizes generation 0s playoff with initialSize, not generationSize', async () => {
    // "Explore wide, then narrow" (populationSize 8 > generationSize 4) is a
    // documented shape. Sizing every generation with N under-quoted the
    // playoff line by 183%.
    const e = await estimateRunCost(base({
      population: { initialSize: 8, generationSize: 4, seedPrompt: 'S', fill: 'auto' },
      pairwise: { enabled: true, contenders: 8 },
      targets: { maxGenerations: 2 },
    }), flatCost);
    const playoff = e.breakdown.find(b => b.label === 'Pairwise playoffs')!;
    // gen0: min(8,8)=8 contenders -> 28 pairs; gen1: min(8,4)=4 -> 6 pairs.
    // L=1 llm_grade test, both orders => (28 + 6) * 1 * 2
    expect(playoff.calls).toBe((28 + 6) * 1 * 2);
  });
});

describe('estimateRunCost surfaces misconfiguration before you pay', () => {
  it('warns when the holdout leaves no fitness tests', async () => {
    // The engine throws 'Holdout configuration leaves no fitness tests' AFTER
    // the run row has been created. Preflight is where that belongs.
    const e = await estimateRunCost(base({ holdoutShare: 1 }), flatCost);
    expect(e.warnings.some(w => w.includes('NO fitness tests'))).toBe(true);
  });

  it('warns when holdoutShare rounds down to zero held-out tests', async () => {
    // Silent otherwise: the run completes and the report can only quote the
    // training delta it selected for, which reads as a real improvement.
    const e = await estimateRunCost(base({ holdoutShare: 0.1 }), flatCost);
    expect(e.warnings.some(w => w.includes('rounds down to ZERO'))).toBe(true);
  });

  it('warns when pairwise is enabled but no fitness test is judged', async () => {
    const e = await estimateRunCost(base({
      pairwise: { enabled: true, contenders: 4 },
      testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'P', expected: 'x' }],
    }), flatCost);
    expect(e.warnings.some(w => w.includes('no playoff will run'))).toBe(true);
  });

  it('stays quiet when the holdout is configured sensibly', async () => {
    const e = await estimateRunCost(base({ holdoutShare: 0.5 }), flatCost);
    expect(e.warnings.some(w => /NO fitness tests|rounds down to ZERO/.test(w))).toBe(false);
  });
});

describe('estimateRunCost dollar band', () => {
  it('does not cap the high side at a token count the config never chose', async () => {
    // The high side was Math.min(serviceModelMaxTokens, 1024) — an assumption
    // that no reply exceeds 1024 tokens even when the config authorises 20000.
    // An ordinary 3000-token-output run then spent 2.2x the quoted "high".
    const small = await estimateRunCost(base({ serviceModelMaxTokens: 256 }), flatCost);
    const large = await estimateRunCost(base({ serviceModelMaxTokens: 20000 }), flatCost);
    expect(large.high).toBeGreaterThan(small.high);
    expect(large.calls).toBe(small.calls); // token cap changes money, not calls
  });

  it('states the worst case when every reply could run to the token cap', async () => {
    const e = await estimateRunCost(base({ serviceModelMaxTokens: 20000 }), flatCost);
    const worst = e.warnings.find(w => w.startsWith('worst case $'));
    expect(worst).toBeDefined();
    expect(worst).toContain('20000');
    // It must exceed the quoted band — otherwise it is not a ceiling.
    const quoted = Number(worst!.match(/worst case \$([\d.]+)/)![1]);
    expect(quoted).toBeGreaterThan(e.high);
  });

  it('discloses that mutation call counts are nominal, not a ceiling', async () => {
    // Since pass 18 BOTH steps retry (proposal and apply/merge), so the
    // per-child ceiling is 2×retries calls — the warning must name that bound
    // (pass 19, hunter B F3: the old wording covered only proposal retries).
    const e = await estimateRunCost(base({ retries: 3 }), flatCost);
    expect(e.warnings.some(w => w.includes('nominal') && w.includes('retries BOTH') && w.includes('6 per child'))).toBe(true);
  });
});
