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

// Completion-token assumptions (low side calibrated 2026-07-29 against a real
// flash-lite run: terse tasks emit ~10-50 tokens, so low assumes near-minimal
// outputs — candidate 30, judge 60, prompt-emitting service calls 100).
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

  if (N0 > 1) add('Population fill (mutations)', (N0 - 1) * 2, per(svc, svcPromptTok, 100), per(svc, svcPromptTok, maxOut));
  add('Candidate evaluations', nodes * F * S, per(cand, candPromptTok, 30), per(cand, candPromptTok, maxOut));
  add('LLM grading', nodes * L * S, per(svc, judgePromptTok, 60), per(svc, judgePromptTok, 250));

  const guardrails = config.fitness.guardrails ?? [];
  if (config.fitness.weights.safety && guardrails.length > 0) {
    add('Safety guardrails', nodes * guardrails.length, per(svc, judgePromptTok, 60), per(svc, judgePromptTok, 250));
  }
  if (config.fitness.weights.stability) {
    add('Stability re-runs', nodes * 3, per(cand, candPromptTok, 30), per(cand, candPromptTok, maxOut));
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
  add('Genetic operators', operatorCalls, per(svc, svcPromptTok, 100), per(svc, svcPromptTok, maxOut));

  if (config.pairwise?.enabled && L > 0) {
    const c = Math.min(Math.max(Math.floor(config.pairwise.contenders ?? 4), 2), 8);
    const contenders = Math.min(c, N);
    const pairs = (contenders * (contenders - 1)) / 2;
    add('Pairwise playoffs', G * pairs * L * 2, per(svc, judgePromptTok, 60), per(svc, judgePromptTok, 250));
  }

  if (H > 0) {
    add('Holdout evaluation', 2 * H * S, per(cand, candPromptTok, 30), per(cand, candPromptTok, maxOut));
    if (Hllm > 0) add('Holdout grading', 2 * Hllm * S, per(svc, judgePromptTok, 60), per(svc, judgePromptTok, 250));
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
