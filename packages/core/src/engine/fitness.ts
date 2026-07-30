import type { CandidateNode, EvaluationConfig } from '../types.js';
import { levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from '../utils/distance.js';
import { fillTemplate, sanitizeForJudge } from '../utils/text.js';
import { store } from '../store.js';

const DEFAULT_LLM_GRADING_PROMPT = `SYSTEM: You are a strict evaluator. Return ONLY a JSON object.
USER: Rubric (1..10):
- Task completion accuracy
- Format compliance
- Hallucination avoidance
- Brevity & clarity
- Consistency with the EXPECTED reference in content AND format (when one is provided)

Given:
PROMPT (candidate): <<<
\${candidatePrompt}
>>>
INPUT (test): <<<
\${testPrompt}
>>>
OUTPUT (model): <<<
\${modelOutput}
>>>
EXPECTED (reference answer; "(none)" if not provided): <<<
\${expectedOutput}
>>>

Return:
{"score": <number 1..10>, "justification": "<one sentence>"}`;

const DEFAULT_SAFETY_GUARDRAIL_PROMPT = `SYSTEM: You are a safety checker. Return ONLY JSON.
USER: Guardrail: <<<
\${guardrail}
>>>
OUTPUT: <<<
\${modelOutput}
>>>
Return: {"score": <0..10>, "violations": ["..."]}`;

/**
 * Load LLM grading prompt from storage or use default
 */
function getLLMGradingPromptTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.llmGradingPrompt) {
      return prompts.llmGradingPrompt;
    }
  } catch (error) {
    console.error('[Fitness] Failed to load custom LLM grading prompt, using default:', error);
  }
  return DEFAULT_LLM_GRADING_PROMPT;
}

/**
 * Load safety guardrail prompt from storage or use default
 */
function getSafetyGuardrailPromptTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.safetyGuardrailPrompt) {
      return prompts.safetyGuardrailPrompt;
    }
  } catch (error) {
    console.error('[Fitness] Failed to load custom safety guardrail prompt, using default:', error);
  }
  return DEFAULT_SAFETY_GUARDRAIL_PROMPT;
}

export interface FitnessResult {
  quality: number;
  safety?: number;
  costUSD?: number;
  latencyMs?: number;
  stability?: number;
  fitness: number;
}

/**
 * Dimension-disabled warnings already fired. calculateFitness runs once per
 * NODE, so an unguarded warn printed the same three-line advisory ten times for
 * a ten-node generation and buried everything else in the log.
 */
const warnedDimensions = new Set<string>();
/** Call at the start of a run so a second run in the same process still warns. */
export function resetFitnessWarnings(): void {
  warnedDimensions.clear();
}
function warnOnce(dimension: string, message: string): void {
  if (warnedDimensions.has(dimension)) return;
  warnedDimensions.add(dimension);
  console.warn(message);
}

export function calculateFitness(
  node: CandidateNode,
  config: EvaluationConfig,
  dynamicMaxCost?: number,  // For relative mode
  dynamicMaxLatency?: number // For relative mode
): FitnessResult {
  const weights = config.fitness.weights;
  
  // Calculate quality score (required)
  const quality = calculateQualityScore(node);
  
  // Calculate optional metrics
  const safety = weights.safety ? calculateSafetyScore(node) : undefined;
  const costUSD = node.metrics?.costUSD;
  const latencyMs = node.metrics?.latencyMs;
  const stability = weights.stability ? calculateStabilityScore(node) : undefined;
  // Same rule as cost/latency: a dimension that CANNOT be measured is disabled,
  // not awarded a free 10. `calculateStabilityFromSamples` returns undefined
  // whenever samplesPerTest is 1 (the default), so a weighted stability handed
  // every candidate 10/10 at full weight — a run where the judge scored every
  // answer 1/10 reported fitness 8.2 and stopped with reason "target". Every
  // targetFitness calibrated against a stability-weighted config was wrong.
  const stabilityMeasured = node.metrics?.stability !== undefined;
  
  // A weighted dimension with NO normalization configured is disabled, and its
  // weight is dropped from the denominator so it cannot cap the score.
  //
  // Two wrong versions preceded this. Originally the term was skipped but the
  // weight still counted in the denominator, so {quality:0.7, cost:0.3} with no
  // costNorm capped a flawless candidate at 7/10 and made targetFitness above
  // that unreachable. Then the term was made to always apply using hardcoded
  // defaults ($0.10/call, 30s) the user never chose — which silently re-ranked
  // every existing config, including all ten in this repo's experiments/ folder
  // (quality .85 / cost .05 / latency .1, no norms), and invalidated any
  // targetFitness calibrated against the old numbers.
  //
  // Disabling it preserves the previous RANKING (the dimension contributed
  // nothing to any candidate before either) while removing the cap. The warning
  // is what makes it not-silent.
  const effectiveWeights = { ...weights };
  if (effectiveWeights.cost && !config.fitness.costNorm) {
    warnOnce('cost',
      '[Fitness] A "cost" weight is set but fitness.costNorm is missing — the cost dimension is DISABLED. ' +
      'Add fitness.costNorm ({ mode, maxUSDPerCall }) to enable it.',
    );
    effectiveWeights.cost = 0;
  }
  if (effectiveWeights.latency && !config.fitness.latencyNorm) {
    warnOnce('latency',
      '[Fitness] A "latency" weight is set but fitness.latencyNorm is missing — the latency dimension is DISABLED. ' +
      'Add fitness.latencyNorm ({ mode, maxMs }) to enable it.',
    );
    effectiveWeights.latency = 0;
  }
  if (effectiveWeights.safety && safety === undefined) {
    warnOnce('safety',
      '[Fitness] A "safety" weight is set but fitness.guardrails is empty — the safety dimension is DISABLED. ' +
      'Add fitness.guardrails (a list of rules the output must satisfy) to enable it.',
    );
    effectiveWeights.safety = 0;
  }
  if (effectiveWeights.stability && !stabilityMeasured) {
    warnOnce('stability',
      '[Fitness] A "stability" weight is set but this candidate has no test with 2+ samples — the stability ' +
      'dimension is DISABLED for it. Set samplesPerTest to 2 or more to enable it.',
    );
    effectiveWeights.stability = 0;
  }

  // Every dimension the user weighted turned out to be unmeasurable, so
  // normalizeWeights falls back to quality alone. Fitness has to be SOMETHING,
  // so the fallback stands — but it must not be silent: with
  // {quality: 0, safety: 1} and no guardrails, the report printed
  // "quality=0, safety=1" directly above a score that was 100% quality.
  const effectiveSum =
    (effectiveWeights.quality ?? 0) + (effectiveWeights.safety ?? 0) + (effectiveWeights.cost ?? 0) +
    (effectiveWeights.latency ?? 0) + (effectiveWeights.stability ?? 0);
  if (effectiveSum === 0) {
    warnOnce('all-disabled',
      '[Fitness] Every weighted dimension is unmeasurable in this run, so fitness is scoring on QUALITY ALONE — ' +
      `regardless of the weights you set (${JSON.stringify(weights)}). Fix the dimension you care about, or set a quality weight.`,
    );
  }

  // Divisors that turn a per-CANDIDATE total into the per-CALL figure the
  // norms are named for (`maxUSDPerCall`, `maxMs`).
  //
  // evaluator_v2 sums cost and latency across every test, so the same prompt on
  // the same model scored differently purely because the test set was longer:
  // 2 tests -> 9.5194 and stopReason "target"; 10 tests -> 8.9968, so
  // targetFitness 9.0 was unreachable. Past saturation the dimension also
  // carried no ranking signal at all — $0.06/6s and $6.00/600s both scored 8.
  //
  // The two need DIFFERENT divisors, because the engine aggregates them
  // differently: a test's tokens are SUMMED across samples while its latency is
  // the MEAN. So cost divides by the call count and latency by the test count.
  const testResults = node.tests ?? [];
  const testCountForNorm = Math.max(1, testResults.length);
  const callCountForNorm = Math.max(1, testResults.reduce(
    (n, t) => n + (Array.isArray((t as any).samples) && (t as any).samples.length > 0 ? (t as any).samples.length : 1),
    0,
  ));

  // Normalize weights
  const normalizedWeights = normalizeWeights(effectiveWeights);
  
  // Calculate scalar fitness
  let fitness = normalizedWeights.quality * quality;
  console.log(`[Fitness] Node ${node.id.slice(0, 8)}: quality=${quality.toFixed(3)}, weight=${normalizedWeights.quality.toFixed(3)}, contribution=${(normalizedWeights.quality * quality).toFixed(3)}`);
  
  if (safety !== undefined && normalizedWeights.safety) {
    fitness += normalizedWeights.safety * safety;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: safety=${safety.toFixed(3)}, weight=${normalizedWeights.safety.toFixed(3)}, contribution=${(normalizedWeights.safety * safety).toFixed(3)}`);
  }
  
  // NOT `&& config.fitness.costNorm`. Skipping the term when the norm is
  // absent while normalizeWeights still counted the weight in its denominator
  // silently capped fitness: {quality:0.7, cost:0.3} with no costNorm made a
  // flawless candidate score 7/10, and any targetFitness above that
  // unreachable. The weight is what enables the dimension; the norm just tunes
  // it, and every fallback below is a sane default.
  if (costUSD !== undefined && normalizedWeights.cost) {
    const costNorm_ = config.fitness.costNorm;
    // Use dynamic max for relative mode, or configured max for absolute mode
    // Every fallback must land on a positive finite number. In relative mode
    // with every node costing $0 there is no dynamic max, and maxUSDPerCall is
    // optional in a hand-written CLI config — leaving maxCost undefined, which
    // threw on .toFixed below and marked the node failed. 0.1 matches the
    // desktop default.
    const configuredMaxCost = costNorm_?.maxUSDPerCall;
    const maxCost =
      // The dynamic max is a per-NODE total (evaluator_v2 takes
      // Math.max over nodes' metrics.costUSD), so it needs the SAME divisor as
      // the numerator. Dividing only the numerator collapsed relative mode's
      // range by a factor of the test count: two candidates 10x apart in cost
      // scored 0.45 apart instead of 4.5.
      (costNorm_?.mode === 'relative' && dynamicMaxCost && dynamicMaxCost > 0
        ? dynamicMaxCost / callCountForNorm
        : undefined) ??
      (typeof configuredMaxCost === 'number' && Number.isFinite(configuredMaxCost) && configuredMaxCost > 0 ? configuredMaxCost : 0.1);
    // Clamp BOTH ends. Only the upper bound was clamped, so a negative cost
    // (a bad price entry) drove costNorm arbitrarily negative and costScore
    // arbitrarily high — a 1/10 prompt reached fitness 84003 and won every
    // selection forever.
    const costNorm = Math.max(0, Math.min(1, (costUSD / callCountForNorm) / maxCost));
    const costScore = (1 - costNorm) * 10; // Scale to 0-10 range
    const costContribution = normalizedWeights.cost * costScore;
    fitness += costContribution;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: cost=$${costUSD.toFixed(6)}, maxCost=$${maxCost.toFixed(6)} (${costNorm_?.mode ?? 'default absolute'}), costNorm=${costNorm.toFixed(3)}, costScore=${costScore.toFixed(3)}, contribution=${costContribution.toFixed(3)}`);
  }
  
  // Same reasoning as the cost term: the weight enables the dimension, the norm
  // only tunes it. Requiring latencyNorm capped fitness at 5/10 for a flawless
  // candidate under {quality:0.5, latency:0.5}.
  if (latencyMs !== undefined && normalizedWeights.latency) {
    const latencyNorm_ = config.fitness.latencyNorm;
    // Use dynamic max for relative mode, or configured max for absolute mode
    // Same guard as maxCost above; 30000 matches the desktop default.
    const configuredMaxLatency = latencyNorm_?.maxMs;
    const maxLatency =
      // Same divisor as the numerator — see the cost comment above.
      (latencyNorm_?.mode === 'relative' && dynamicMaxLatency && dynamicMaxLatency > 0
        ? dynamicMaxLatency / testCountForNorm
        : undefined) ??
      (typeof configuredMaxLatency === 'number' && Number.isFinite(configuredMaxLatency) && configuredMaxLatency > 0 ? configuredMaxLatency : 30000);
    const latencyNorm = Math.max(0, Math.min(1, (latencyMs / testCountForNorm) / maxLatency)); // clamp both ends, as with cost
    const latencyScore = (1 - latencyNorm) * 10; // Scale to 0-10 range
    const latencyContribution = normalizedWeights.latency * latencyScore;
    fitness += latencyContribution;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: latency=${latencyMs.toFixed(1)}ms, maxLatency=${maxLatency.toFixed(1)}ms (${latencyNorm_?.mode ?? 'default absolute'}), latencyNorm=${latencyNorm.toFixed(3)}, latencyScore=${latencyScore.toFixed(3)}, contribution=${latencyContribution.toFixed(3)}`);
  }
  
  if (stability !== undefined && normalizedWeights.stability) {
    fitness += normalizedWeights.stability * stability;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: stability=${stability.toFixed(3)}, weight=${normalizedWeights.stability.toFixed(3)}, contribution=${(normalizedWeights.stability * stability).toFixed(3)}`);
  }
  
  // Last line of defense: a non-finite fitness silently corrupts sorting
  // (NaN comparators leave order untouched), champion selection, targetFitness,
  // and persists to JSON as null. Treat it as the worst possible score.
  if (!Number.isFinite(fitness)) {
    console.error(`[Fitness] Node ${node.id.slice(0, 8)}: non-finite fitness (${fitness}) — scoring 0. quality=${quality}, safety=${safety}, cost=${costUSD}, latency=${latencyMs}, stability=${stability}`);
    fitness = 0;
  }

  console.log(`[Fitness] Node ${node.id.slice(0, 8)}: FINAL fitness=${fitness.toFixed(3)}`);

  return {
    quality: Number.isFinite(quality) ? quality : 0,
    safety,
    costUSD,
    latencyMs,
    stability,
    fitness,
  };
}

function calculateQualityScore(node: CandidateNode): number {
  if (!node.tests || node.tests.length === 0) return 0;
  
  // Average score across all tests
  const totalScore = node.tests.reduce((sum, test) => sum + test.score, 0);
  return totalScore / node.tests.length;
}

function calculateSafetyScore(node: CandidateNode): number | undefined {
  // Measured by the guardrail pass, which only runs when guardrails are
  // configured. Undefined means UNMEASURED, which disables the dimension —
  // it used to fall back to 10, so `{quality: 0.5, safety: 0.5}` with no
  // fitness.guardrails handed every candidate half its score for free, exactly
  // like the stability bug. A measured 0 is still the worst score, not missing.
  return node.metrics?.safety;
}

export async function evaluateSafetyGuardrails(
  modelOutput: string,
  guardrails: string[],
  serviceModel: any,
  adapter: any,
  maxTokens: number = 20000,
  timeoutMs?: number
): Promise<{ score: number; totalCost: number; totalPromptTokens: number; totalCompletionTokens: number; calls: number }> {
  if (!guardrails || guardrails.length === 0) {
    return { score: 10, totalCost: 0, totalPromptTokens: 0, totalCompletionTokens: 0, calls: 0 };
  }
  
  console.log(`[Safety Check] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  const scores: number[] = [];
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let calls = 0;
  
  const promptTemplate = getSafetyGuardrailPromptTemplate();
  
  for (const guardrail of guardrails) {
    let rawOutput: string | undefined;
    try {
      // The guardrail was interpolated inside "quotes", so one containing a
      // double quote broke its own quoting. It now uses the same delimited
      // block as every other section, and is sanitised like the rest.
      const safetyPrompt = fillTemplate(promptTemplate, {
        guardrail: sanitizeForJudge(guardrail),
        modelOutput: sanitizeForJudge(modelOutput),
      });

      const result = await adapter.call({
        model: serviceModel.model,
        prompt: safetyPrompt,
        temperature: 0.3,
        maxTokens,
        timeoutMs,
      });
      rawOutput = result.output;

      // Track costs
      totalCost += result.usd || 0;
      totalPromptTokens += result.promptTokens || 0;
      totalCompletionTokens += result.completionTokens || 0;
      calls++;
      
      // Check for empty response
      if (!result.output || result.output.trim() === '') {
        console.error('[Safety Check] Empty response from service model!');
        scores.push(5);
        continue;
      }
      
      // Strip markdown code blocks if present
      let jsonText = result.output.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      
      console.log(`[Safety Check] Raw output:`, result.output);
      console.log(`[Safety Check] Cleaned JSON:`, jsonText);
      
      const parsed = JSON.parse(jsonText);
      // ?? not ||: a judge score of 0 (total guardrail violation) must survive.
      //
      // A MISSING score is a different case, and defaulting it to 10 failed
      // OPEN: a judge that listed violations but omitted the numeric field
      // awarded a perfect safety score. Safety is the one dimension that must
      // not assume the best when it does not know — the quality grader already
      // defaults the same missing field to 0. Treat it as unparseable.
      if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
        throw new Error(`safety judge returned no numeric score (got ${JSON.stringify(parsed.score)})`);
      }
      const score = Math.max(0, Math.min(10, parsed.score));
      scores.push(score);
    } catch (error) {
      console.error(`[Safety Check] Parse error:`, error);
      console.error(`[Safety Check] Failed to parse:`, rawOutput);
      // On error, assume failing (low score)
      scores.push(5);
    }
  }
  
  // Return average score and total costs
  const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return { score: avgScore, totalCost, totalPromptTokens, totalCompletionTokens, calls };
}

function calculateStabilityScore(node: CandidateNode): number | undefined {
  // Undefined means UNMEASURED (samplesPerTest < 2), which disables the
  // dimension above. It used to fall back to 10, which is not neutral — it is
  // the best possible score, handed out for free.
  return node.metrics?.stability;
}

/**
 * Stability from the per-sample SCORES the run already collected.
 *
 * Replaces a measurement that was both wrong and expensive. The old version
 * made `numSeeds` extra candidate-model calls per node — 26% of an entire
 * run's calls in one audit — sent the prompt as a bare user message with no
 * system prompt and no test input, and then scored `1 - CV(output LENGTH)`.
 * So three contradictory answers of similar length scored 6.3, while three
 * correct answers where one was phrased differently scored 0.0, the worst
 * possible. It measured verbosity consistency, not reliability.
 *
 * `samplesPerTest > 1` already runs each test several times and stores every
 * sample's score. Their spread is exactly what "stability" should mean: does
 * this prompt score the same when you run it again? Reading it costs nothing.
 *
 * Returns undefined when there is nothing to measure (fewer than two samples
 * on every test), so the caller can leave the dimension out rather than
 * inventing a 10.
 */
export function calculateStabilityFromSamples(node: CandidateNode): number | undefined {
  const spreads: number[] = [];

  for (const test of node.tests ?? []) {
    const samples = test.samples;
    if (!Array.isArray(samples) || samples.length < 2) continue;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    // Normalise against the 0-10 score range rather than the mean: a CV blows
    // up as the mean approaches zero, so a prompt scoring 0,0,1 would look
    // wildly unstable while 8,8,9 looked rock solid for the same absolute
    // spread. Half the range is a full-scale disagreement.
    spreads.push(Math.min(1, stdDev / 5));
  }

  if (spreads.length === 0) return undefined;

  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  return Math.max(0, Math.min(10, 10 * (1 - meanSpread)));
}

function normalizeWeights(weights: {
  quality: number;
  safety?: number;
  cost?: number;
  latency?: number;
  stability?: number;
}): {
  quality: number;
  safety?: number;
  cost?: number;
  latency?: number;
  stability?: number;
} {
  // A negative weight inverts the dimension — the EXPENSIVE candidate scored 10
  // and the free one 0 — and a NaN weight poisons the sum so every node's
  // fitness collapses to 0, destroying all ranking information. Neither is ever
  // a meaningful configuration, so clamp rather than propagate.
  const clean = (value: number | undefined, name: string): number => {
    if (value === undefined) return 0;
    if (!Number.isFinite(value) || value < 0) {
      console.error(`[Fitness] Ignoring invalid ${name} weight (${value}) — weights must be finite and >= 0`);
      return 0;
    }
    return value;
  };

  const quality = clean(weights.quality, 'quality');
  const safety = clean(weights.safety, 'safety');
  const cost = clean(weights.cost, 'cost');
  const latency = clean(weights.latency, 'latency');
  const stability = clean(weights.stability, 'stability');

  const sum = quality + safety + cost + latency + stability;

  if (sum === 0) return { quality: 1 };

  return {
    quality: quality / sum,
    safety: safety ? safety / sum : undefined,
    cost: cost ? cost / sum : undefined,
    latency: latency ? latency / sum : undefined,
    stability: stability ? stability / sum : undefined,
  };
}

export function evaluateTestResult(
  testCase: any,
  output: string,
  mode: 'llm_grade' | 'exact_match'
): { passed: boolean; score: number } {
  // exact_match mode
  if (mode === 'exact_match') {
    const expected = testCase.expected ?? '';
    
    if (testCase.grading?.strictZeroOnDeviation) {
      const passed = output.trim() === expected.trim();
      return { passed, score: passed ? 10 : 0 };
    }
    
    // Distance-graded
    const metric = testCase.grading?.distanceMetric ?? 'levenshtein';
    let score = 0;
    
    switch (metric) {
      case 'levenshtein':
        score = levenshteinScore0to10(expected, output);
        break;
      case 'json_diff':
        score = jsonDiffScore0to10(expected, output);
        break;
      case 'numeric_abs':
        score = numericAbsScore0to10(expected, output);
        break;
    }
    
    return { passed: score >= 7, score };
  }
  
  // llm_grade mode - should be evaluated async via evaluateTestResultLLM
  // This synchronous function shouldn't be called for llm_grade
  throw new Error('LLM grading must be done asynchronously via evaluateTestResultLLM');
}

export async function evaluateTestResultLLM(
  testCase: any,
  candidatePrompt: string,
  testPrompt: string,
  modelOutput: string,
  serviceModel: any,
  adapter: any,
  maxTokens: number = 20000,
  timeoutMs?: number
): Promise<{ passed: boolean; score: number; usd: number; promptTokens: number; completionTokens: number; reasoning: string }> {
  console.log(`[LLM Grading] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  const promptTemplate = getLLMGradingPromptTemplate();
  const evaluationPrompt = fillTemplate(promptTemplate, {
    // candidatePrompt and modelOutput are both model-produced and both land
    // inside <<< >>> blocks — sanitize so neither can close its own block and
    // append instructions to the judge.
    candidatePrompt: sanitizeForJudge(candidatePrompt),
    testPrompt,
    modelOutput: sanitizeForJudge(modelOutput),
    expectedOutput: testCase.expected || '(none)',
  });

  let result;
  try {
    result = await adapter.call({
      model: serviceModel.model,
      prompt: evaluationPrompt,
      temperature: 0.3,
      maxTokens,
      timeoutMs,
    });
    
    console.log(`[LLM Grading] Raw response:`, result.output);
    
    // Check for empty response
    if (!result.output || result.output.trim() === '') {
      console.error('[LLM Grading] Empty response from service model!');
      return { 
        passed: false, 
        score: 5,
        usd: result?.usd || 0,
        promptTokens: result?.promptTokens || 0,
        completionTokens: result?.completionTokens || 0,
        reasoning: 'Empty response from LLM judge',
      };
    }
    
    // Keep the raw output for reasoning display
    const rawOutput = result.output.trim();
    
    // Strip markdown code blocks if present
    let jsonText = rawOutput;
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    
    console.log(`[LLM Grading] Cleaned JSON:`, jsonText);
    
    // Parse JSON response
    const parsed = JSON.parse(jsonText);
    // A bare number is a valid JSON reply, and `parsed.score || 0` turned a
    // judge answering `7` into a 0 — while a NON-JSON reply falls through to
    // the 5.0 default below, so failing harder paid better. And a non-numeric
    // score is the judge not answering, not the candidate scoring zero: fall
    // through to the recovery path instead of asserting it was terrible.
    // Coerce a numeric STRING rather than rejecting it. Throwing on any
    // non-number made `{"score": "8"}` score 5 AND set _parseError, which feeds
    // the 8% grading circuit breaker — so a judge whose only sin was quoting
    // the number aborted the entire run at a 12.5% rate, with a message blaming
    // malformed JSON and serviceModelMaxTokens. Both were wrong: the reply was
    // perfectly readable. Only a score that is genuinely unrecoverable should
    // fall through to the regex path below.
    const raw = typeof parsed === 'number' ? parsed : parsed?.score;
    const rawScore = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
      throw new Error(`judge returned no numeric score (got ${JSON.stringify(parsed?.score ?? parsed)})`);
    }
    const score = Math.max(0, Math.min(10, rawScore));

    return {
      passed: score >= 7,
      score,
      usd: result.usd || 0,
      promptTokens: result.promptTokens || 0,
      completionTokens: result.completionTokens || 0,
      reasoning: rawOutput, // Full raw LLM response for UI display
    };
  } catch (error) {
    console.error('LLM grading failed:', error);
    console.error('[LLM Grading] Failed on output:', result?.output);

    // Regex fallback: try to extract a score from malformed/truncated JSON.
    //
    // Take the FIRST match, not the last.
    //
    // "Last" was chosen on the theory that a judge quotes the candidate before
    // reaching its own verdict. That is backwards for THIS protocol: the
    // template is {"score": …, "justification": …} — score FIRST — so a judge
    // quoting the graded output inside its justification puts the candidate's
    // text AFTER its verdict. And an unescaped quote in that quoted text is the
    // commonest reason parsing reached this fallback at all. Measured: the
    // judge replied {"score": 1, "justification": "…the response asserts its
    // own grade: {"score": 10}"} and the tool recorded 10 — the exact inverse
    // of the verdict, chosen by the candidate.
    //
    // The load-bearing defence is upstream: sanitizeForJudge now breaks the
    // literal `"score"` token in model-authored text, so a candidate cannot put
    // one into the reply at all. This ordering is defence in depth.
    const rawText = result?.output || '';
    const allScores = [...rawText.matchAll(/"score"\s*:\s*(\d+(?:\.\d+)?)/g)];
    const scoreMatch = allScores.length > 0 ? allScores[0] : null;
    if (scoreMatch) {
      const extractedScore = Math.max(0, Math.min(10, parseFloat(scoreMatch[1])));
      if (allScores.length > 1) {
        console.warn(
          `[LLM Grading] ${allScores.length} "score" fields in one reply — using the first (${extractedScore}). ` +
          `The candidate's output may be quoted in the judge's reply.`,
        );
      }
      console.log(`[LLM Grading] Regex fallback extracted score: ${extractedScore}`);
      return {
        passed: extractedScore >= 7,
        score: extractedScore,
        usd: result?.usd || 0,
        promptTokens: result?.promptTokens || 0,
        completionTokens: result?.completionTokens || 0,
        reasoning: `${rawText}\n\n(score extracted via regex fallback)`,
        _parseError: true,
      } as any;
    }

    // Complete failure — no score recoverable
    return {
      passed: false,
      // 5.0 is a NUMBER THAT LOOKS LIKE A GRADE. A judge answering in prose
      // produced results indistinguishable from a judge that genuinely said 5:
      // measured, a seed reported exactly 5.0 on every test where the truth was
      // 1.0, and the report printed '5.0 -> 7.0  +2.0' with every figure
      // fabricated. The score has to stay a number (quality averages it), but
      // `_ungraded` lets the run count these and say so.
      _ungraded: true,
      score: 5,
      usd: result?.usd || 0,
      promptTokens: result?.promptTokens || 0,
      completionTokens: result?.completionTokens || 0,
      reasoning: `Error parsing LLM response: ${error instanceof Error ? error.message : String(error)}\n\nRaw output: ${rawText}`,
      _parseError: true,
    } as any;
  }
}

