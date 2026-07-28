import type { CandidateNode, EvaluationConfig } from '../types.js';
import { levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from '../utils/distance.js';
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
USER: Guardrail: "\${guardrail}"
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
  
  // Normalize weights
  const normalizedWeights = normalizeWeights(weights);
  
  // Calculate scalar fitness
  let fitness = normalizedWeights.quality * quality;
  console.log(`[Fitness] Node ${node.id.slice(0, 8)}: quality=${quality.toFixed(3)}, weight=${normalizedWeights.quality.toFixed(3)}, contribution=${(normalizedWeights.quality * quality).toFixed(3)}`);
  
  if (safety !== undefined && normalizedWeights.safety) {
    fitness += normalizedWeights.safety * safety;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: safety=${safety.toFixed(3)}, weight=${normalizedWeights.safety.toFixed(3)}, contribution=${(normalizedWeights.safety * safety).toFixed(3)}`);
  }
  
  if (costUSD !== undefined && normalizedWeights.cost && config.fitness.costNorm) {
    // Use dynamic max for relative mode, or configured max for absolute mode
    const maxCost = dynamicMaxCost && config.fitness.costNorm.mode === 'relative' 
      ? dynamicMaxCost 
      : config.fitness.costNorm.maxUSDPerCall;
    const costNorm = Math.min(1, costUSD / maxCost);
    const costScore = (1 - costNorm) * 10; // Scale to 0-10 range
    const costContribution = normalizedWeights.cost * costScore;
    fitness += costContribution;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: cost=$${costUSD.toFixed(6)}, maxCost=$${maxCost.toFixed(6)} (${config.fitness.costNorm.mode}), costNorm=${costNorm.toFixed(3)}, costScore=${costScore.toFixed(3)}, contribution=${costContribution.toFixed(3)}`);
  }
  
  if (latencyMs !== undefined && normalizedWeights.latency && config.fitness.latencyNorm) {
    // Use dynamic max for relative mode, or configured max for absolute mode
    const maxLatency = dynamicMaxLatency && config.fitness.latencyNorm.mode === 'relative'
      ? dynamicMaxLatency
      : config.fitness.latencyNorm.maxMs;
    const latencyNorm = Math.min(1, latencyMs / maxLatency);
    const latencyScore = (1 - latencyNorm) * 10; // Scale to 0-10 range
    const latencyContribution = normalizedWeights.latency * latencyScore;
    fitness += latencyContribution;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: latency=${latencyMs.toFixed(1)}ms, maxLatency=${maxLatency.toFixed(1)}ms (${config.fitness.latencyNorm.mode}), latencyNorm=${latencyNorm.toFixed(3)}, latencyScore=${latencyScore.toFixed(3)}, contribution=${latencyContribution.toFixed(3)}`);
  }
  
  if (stability !== undefined && normalizedWeights.stability) {
    fitness += normalizedWeights.stability * stability;
    console.log(`[Fitness] Node ${node.id.slice(0, 8)}: stability=${stability.toFixed(3)}, weight=${normalizedWeights.stability.toFixed(3)}, contribution=${(normalizedWeights.stability * stability).toFixed(3)}`);
  }
  
  console.log(`[Fitness] Node ${node.id.slice(0, 8)}: FINAL fitness=${fitness.toFixed(3)}`);
  
  return {
    quality,
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

function calculateSafetyScore(node: CandidateNode): number {
  // Safety score will be calculated separately via guardrails
  // This function returns the pre-calculated safety metric
  return node.metrics?.safety || 10;
}

export async function evaluateSafetyGuardrails(
  modelOutput: string,
  guardrails: string[],
  serviceModel: any,
  adapter: any,
  maxTokens: number = 20000
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
      const safetyPrompt = promptTemplate
        .replace(/\$\{guardrail\}/g, guardrail)
        .replace(/\$\{modelOutput\}/g, modelOutput);

      const result = await adapter.call({
        model: serviceModel.model,
        prompt: safetyPrompt,
        temperature: 0.3,
        maxTokens,
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
      const score = Math.max(0, Math.min(10, parsed.score || 10));
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

function calculateStabilityScore(node: CandidateNode): number {
  // Stability requires multiple runs with different seeds
  // If no stability data, return neutral score
  if (!node.metrics?.stability) return 10;
  return node.metrics.stability;
}

export async function calculateStabilityAcrossSeeds(
  prompt: string,
  params: any,
  config: any,
  _testSet: any[],
  adapter: any,
  numSeeds: number = 3
): Promise<{ score: number; totalCost: number; totalPromptTokens: number; totalCompletionTokens: number; calls: number }> {
  // Run the same prompt with different seeds
  const results: number[] = [];
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let calls = 0;
  
  for (let i = 0; i < numSeeds; i++) {
    try {
      const result = await adapter.call({
        model: params.model.model,
        prompt,
        temperature: params.temperature,
        seed: 1000 + i, // Different seeds
        maxTokens, // Use configurable max tokens
      });
      
      // Track costs
      totalCost += result.usd || 0;
      totalPromptTokens += result.promptTokens || 0;
      totalCompletionTokens += result.completionTokens || 0;
      calls++;
      
      // Get quality score for this run
      // For simplicity, use output length as proxy for consistency
      results.push(result.output.length);
    } catch (error) {
      console.error('Stability test failed:', error);
    }
  }
  
  if (results.length < 2) {
    return { score: 10, totalCost, totalPromptTokens, totalCompletionTokens, calls }; // Can't measure variance
  }
  
  // Calculate coefficient of variation (inverse = stability)
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const variance = results.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / results.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0; // Coefficient of variation
  
  // Convert to 0-10 score (lower CV = higher stability)
  const stabilityScore = Math.max(0, Math.min(10, 10 * (1 - cv)));
  return { score: stabilityScore, totalCost, totalPromptTokens, totalCompletionTokens, calls };
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
  const sum =
    weights.quality +
    (weights.safety ?? 0) +
    (weights.cost ?? 0) +
    (weights.latency ?? 0) +
    (weights.stability ?? 0);
  
  if (sum === 0) return { quality: 1 };
  
  return {
    quality: weights.quality / sum,
    safety: weights.safety ? weights.safety / sum : undefined,
    cost: weights.cost ? weights.cost / sum : undefined,
    latency: weights.latency ? weights.latency / sum : undefined,
    stability: weights.stability ? weights.stability / sum : undefined,
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
  maxTokens: number = 20000
): Promise<{ passed: boolean; score: number; usd: number; promptTokens: number; completionTokens: number; reasoning: string }> {
  console.log(`[LLM Grading] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  const promptTemplate = getLLMGradingPromptTemplate();
  const evaluationPrompt = promptTemplate
    .replace(/\$\{candidatePrompt\}/g, candidatePrompt)
    .replace(/\$\{testPrompt\}/g, testPrompt)
    .replace(/\$\{modelOutput\}/g, modelOutput)
    .replace(/\$\{expectedOutput\}/g, testCase.expected || '(none)');

  let result;
  try {
    result = await adapter.call({
      model: serviceModel.model,
      prompt: evaluationPrompt,
      temperature: 0.3,
      maxTokens,
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
    const score = Math.max(0, Math.min(10, parsed.score || 0));

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

    // Regex fallback: try to extract score from malformed/truncated JSON
    const rawText = result?.output || '';
    const scoreMatch = rawText.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
    if (scoreMatch) {
      const extractedScore = Math.max(0, Math.min(10, parseFloat(scoreMatch[1])));
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
      score: 5,
      usd: result?.usd || 0,
      promptTokens: result?.promptTokens || 0,
      completionTokens: result?.completionTokens || 0,
      reasoning: `Error parsing LLM response: ${error instanceof Error ? error.message : String(error)}\n\nRaw output: ${rawText}`,
      _parseError: true,
    } as any;
  }
}

