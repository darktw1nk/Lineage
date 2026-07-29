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

// Shared purpose vocabulary: the estimator's breakdown and the runtime cost
// accounting (evaluator accrueCost) use these EXACT labels so predicted and
// actual join by key with no mapping layer.
export const COST_LABELS = {
  fill: 'Population fill (mutations)',
  candidates: 'Candidate evaluations',
  grading: 'LLM grading',
  safety: 'Safety guardrails',
  // Kept so an OLD run's stored costBreakdown still renders a readable label
  // in the report; nothing accrues to it any more.
  stability: 'Stability re-runs (legacy)',
  operators: 'Genetic operators',
  playoff: 'Pairwise playoffs',
  holdout: 'Holdout evaluation',
  holdoutGrading: 'Holdout grading',
} as const;

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
  const unpricedModels = new Set<string>();

  const priceOf = async (models: ModelRef[]): Promise<Price> => {
    let p = 0, c = 0;
    for (const m of models) {
      const entry = await getCost(m);
      if (!entry || (entry.promptUSDper1k === 0 && entry.completionUSDper1k === 0)) {
        // Once per model, not once per lookup — the same model is priced
        // several times and the note was repeated verbatim each time.
        const ref = `${m.provider}/${m.model}`;
        if (!unpricedModels.has(ref)) unpricedModels.add(ref);
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
  // Clamp exactly like generation.ts does. Without the `N - 1` cap, eliteShare
  // >= 0.875 made E === N, so children === 0 and the whole operator line
  // vanished from the estimate while the engine still ran (and billed) it.
  const E = eliteShare > 0
    ? Math.min(Math.max(1, Math.round(N * eliteShare)), Math.max(0, N - 1))
    : 0;
  const S = Math.min(Math.max(Math.floor(config.samplesPerTest ?? 1), 1), 10);
  // MUST match evaluator_v2's partition seed exactly (`config.holdoutSeed ?? 42`,
  // deliberately NOT coupled to config.seed). Falling back through config.seed
  // here made the preview hold out the exact complement of what the run holds
  // out: a config with `seed` set previewed llm_grade fitness tests for a run
  // whose fitness set contained none.
  const { fitnessTests, holdoutTests } = partitionTestSet(
    config.testSet, config.holdoutShare ?? 0, config.holdoutSeed ?? 42);
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

  // `serviceModelMaxTokens` caps completions on EVERY call (candidate and
  // service alike — see types.ts), so it is the only real ceiling in the run.
  const capOut = Math.max(1, config.serviceModelMaxTokens || 20000);
  // The band's high side used to be `Math.min(cap, 1024)`: a flat assumption
  // that no reply ever exceeds 1024 tokens EVEN WHEN the config authorises
  // 20000. A perfectly ordinary 3000-token-output run then spent 2.2x the
  // quoted "high", and a 10000-token one 5.7x — with the call count predicted
  // exactly. 4096 is a forecast for ordinary long answers, not a promise; the
  // true exposure at `capOut` is computed below and stated as its own warning.
  const BAND_OUT = 4096;
  const bandOut = Math.min(capOut, BAND_OUT);

  // Prompt sizes are a low/high pair too. The low side assumes prompts stay
  // seed-sized; the high side assumes evolution has grown them to the largest
  // thing the service model can emit in one call, which is `out`. Deriving the
  // candidate prompt from `seedPrompt` ALONE was wrong in the direction that
  // matters: growing the prompt is the entire point of the tool, and generation
  // 3's prompts measured ~60x the seed.
  const candPromptLow = Math.ceil((seedTok + avgTestTok) * 1.2);
  const candPromptHigh = (out: number) => Math.ceil((out + avgTestTok) * 1.2);
  const svcPromptLow = Math.ceil(seedTok * 1.2) + 400;
  const svcPromptHigh = (out: number) => Math.ceil(out * 1.2) + 400;
  // A judge reads the rubric AND the candidate's output. The flat `+400` stood
  // in for both, so judging a 3000-token answer was ~8x under.
  const judgePromptLow = candPromptLow + 400 + 30;
  const judgePromptHigh = (out: number) => candPromptHigh(out) + 400 + out;

  // A mutation/meta child costs 1 proposal + 1 apply call nominally, but the
  // proposal loop retries up to `config.retries` times when the service model
  // returns something unusable (mutations.ts). Nominal calls stay nominal; the
  // high side has to cover the retry ceiling.
  const maxProposalAttempts = Math.max(1, config.retries ?? 3);
  const retryFactor = (maxProposalAttempts + 1) / 2;

  // Clamp like the accrual path does. A catalog row can still carry a negative
  // price — an OpenRouter "-1" sentinel synced before that filter existed — and
  // the preflight banner then quoted a NEGATIVE cost while the run itself
  // correctly recorded $0.
  const per = (p: Price, promptT: number, compT: number) => {
    const usd = (promptT / 1000) * p.promptUSDper1k + (compT / 1000) * p.completionUSDper1k;
    return Number.isFinite(usd) ? Math.max(0, usd) : 0;
  };

  // Each line carries its high side as a FUNCTION of the assumed completion
  // length, so the same descriptors can be materialized twice: once at the
  // forecast length for the band, once at the configured cap for the true
  // worst case reported in the warnings.
  type Line = { label: string; calls: number; lowPer: number; highPer: (out: number) => number };
  const lines: Line[] = [];
  const add = (label: string, calls: number, lowPer: number, highPer: (out: number) => number) => {
    if (calls > 0) lines.push({ label, calls, lowPer, highPer });
  };

  // Manual populations supply their own prompts — no fill mutations happen
  if (N0 > 1 && config.population.fill !== 'manual') {
    add(COST_LABELS.fill, (N0 - 1) * 2,
      per(svc, svcPromptLow, 100),
      out => per(svc, svcPromptHigh(out), out) * retryFactor);
  }
  add(COST_LABELS.candidates, nodes * F * S,
    per(cand, candPromptLow, 30),
    out => per(cand, candPromptHigh(out), out));
  add(COST_LABELS.grading, nodes * L * S,
    per(svc, judgePromptLow, 60),
    out => per(svc, judgePromptHigh(out), 250));

  const guardrails = config.fitness.guardrails ?? [];
  if (config.fitness.weights.safety && guardrails.length > 0) {
    add(COST_LABELS.safety, nodes * guardrails.length,
      per(svc, judgePromptLow, 60),
      out => per(svc, judgePromptHigh(out), 250));
  }
  // Stability costs NOTHING to estimate: it is read from the per-sample scores
  // `samplesPerTest` already produces, and those calls are counted in
  // COST_LABELS.candidates above. This used to add `nodes * 3` phantom calls —
  // 108 of 338 in the docs' own example, a 32% over-count on the very config a
  // new user copies — from back when stability made its own extra provider
  // calls to measure reply-length variance.

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
      // Math.round here vs the engine's largest-remainder distribution can
      // drift ±1 child per operator per transition — fine for a band estimate.
      operatorCalls += Math.round((share / totalShare) * children) * (CALLS_PER_CHILD[name] ?? 0);
    }
    operatorCalls *= transitions;
  }
  add(COST_LABELS.operators, operatorCalls,
    per(svc, svcPromptLow, 100),
    out => per(svc, svcPromptHigh(out), out) * retryFactor);

  if (config.pairwise?.enabled && L > 0) {
    const c = Math.min(Math.max(Math.floor(config.pairwise.contenders ?? 4), 2), 8);
    // The playoff draws from the nodes the generation ACTUALLY has, and
    // generation 0 has `initialSize` of them, not `generationSize`. Sizing every
    // generation with N under-quoted the common "explore wide, then narrow"
    // shape (populationSize 8 > generationSize 4) by 183% on the playoff line.
    let pairCalls = 0;
    for (let g = 0; g < G; g++) {
      const pool = g === 0 ? N0 : N;
      const contenders = Math.min(c, pool);
      if (contenders < 2) continue;
      pairCalls += ((contenders * (contenders - 1)) / 2) * L * 2;
    }
    add(COST_LABELS.playoff, pairCalls,
      per(svc, judgePromptLow, 60),
      out => per(svc, judgePromptHigh(out), 250));
  }

  if (H > 0) {
    add(COST_LABELS.holdout, 2 * H * S,
      per(cand, candPromptLow, 30),
      out => per(cand, candPromptHigh(out), out));
    if (Hllm > 0) add(COST_LABELS.holdoutGrading, 2 * Hllm * S,
      per(svc, judgePromptLow, 60),
      out => per(svc, judgePromptHigh(out), 250));
  }

  const breakdown: CostEstimate['breakdown'] = lines.map(l => ({
    label: l.label,
    calls: l.calls,
    low: l.calls * l.lowPer,
    high: l.calls * l.highPer(bandOut),
  }));

  const calls = breakdown.reduce((a, b) => a + b.calls, 0);
  const low = breakdown.reduce((a, b) => a + b.low, 0);
  const high = breakdown.reduce((a, b) => a + b.high, 0);
  // What the run costs if EVERY reply runs to the configured cap. This is the
  // number `budgetUSD` actually has to survive.
  const ceiling = lines.reduce((a, l) => a + l.calls * l.highPer(capOut), 0);

  if (config.targets.budgetUSD !== undefined && config.targets.budgetUSD < low) {
    warnings.push(`budgetUSD ($${config.targets.budgetUSD}) is below the low estimate — the run will likely stop early`);
  }
  // `high` is a forecast for ordinary long answers. The only hard bound is the
  // token cap, and quoting a band without ever naming that bound is how a run
  // walks straight through "high".
  if (ceiling > high * 1.05) {
    warnings.push(
      `worst case $${ceiling.toFixed(2)} if every reply runs to serviceModelMaxTokens (${capOut}) — ` +
      `the band above assumes ~${bandOut}-token replies. Lower serviceModelMaxTokens to narrow this.`,
    );
  }
  if (maxProposalAttempts > 1 && (config.population.fill !== 'manual' || operatorCalls > 0)) {
    warnings.push(
      `call counts are nominal: each mutation/meta child re-proposes up to retries (${maxProposalAttempts}) ` +
      `times when the service model returns something unusable, so fill and operator calls can run higher`,
    );
  }
  // Uncatalogued models are the single most consequential thing this preflight
  // can tell you, because their calls are priced at $0 — so the quoted band
  // excludes them AND budgetUSD can never trip. It used to be one lowercase
  // `note:` among five. Say it plainly, and say it louder when a budget is set
  // and therefore about to be silently unenforceable.
  if (unpricedModels.size > 0) {
    const list = [...unpricedModels].join(', ');
    warnings.push(
      config.targets.budgetUSD !== undefined
        ? `NOT PRICED: ${list} — their calls are estimated at $0 and budgetUSD ($${config.targets.budgetUSD}) CANNOT be enforced against them. Run --sync-models, or pick a catalogued model.`
        : `NOT PRICED: ${list} — their calls are estimated at $0, so the figures above exclude them. Run --sync-models, or pick a catalogued model.`,
    );
  }
  warnings.push('cache hits and early stops reduce actual spend');

  return { calls, low, high, perGeneration, breakdown, warnings };
}
