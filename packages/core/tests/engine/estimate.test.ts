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
