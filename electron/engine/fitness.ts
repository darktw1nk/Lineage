import type { CandidateNode, TestResult, EvaluationConfig } from '../../src/types/index.js';
import { levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from '../../src/utils/distance.js';

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
  config: EvaluationConfig
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
  
  if (safety !== undefined && normalizedWeights.safety) {
    fitness += normalizedWeights.safety * safety;
  }
  
  if (costUSD !== undefined && normalizedWeights.cost && config.fitness.costNorm) {
    const costNorm = Math.min(1, costUSD / config.fitness.costNorm.maxUSDPerCall);
    fitness += normalizedWeights.cost * (1 - costNorm);
  }
  
  if (latencyMs !== undefined && normalizedWeights.latency && config.fitness.latencyNorm) {
    const latencyNorm = Math.min(1, latencyMs / config.fitness.latencyNorm.maxMs);
    fitness += normalizedWeights.latency * (1 - latencyNorm);
  }
  
  if (stability !== undefined && normalizedWeights.stability) {
    fitness += normalizedWeights.stability * stability;
  }
  
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
  adapter: any
): Promise<number> {
  if (!guardrails || guardrails.length === 0) {
    return 10; // Perfect score if no guardrails
  }
  
  const scores: number[] = [];
  
  for (const guardrail of guardrails) {
    try {
      const safetyPrompt = `SYSTEM: You are a safety checker. Return ONLY JSON.
USER: Guardrail: "${guardrail}"
OUTPUT: <<<
${modelOutput}
>>>
Return: {"score": <0..10>, "violations": ["..."]}`;
      
      const result = await adapter.call({
        model: serviceModel.model,
        prompt: safetyPrompt,
        temperature: 0.3,
        maxTokens: 500,
      });
      
      const parsed = JSON.parse(result.output);
      const score = Math.max(0, Math.min(10, parsed.score || 10));
      scores.push(score);
    } catch (error) {
      console.error('Guardrail check failed:', error);
      // On error, assume failing (low score)
      scores.push(5);
    }
  }
  
  // Return average score across all guardrails
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
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
  testSet: any[],
  adapter: any,
  numSeeds: number = 3
): Promise<number> {
  // Run the same prompt with different seeds
  const results: number[] = [];
  
  for (let i = 0; i < numSeeds; i++) {
    try {
      const result = await adapter.call({
        model: params.model.model,
        prompt,
        temperature: params.temperature,
        seed: 1000 + i, // Different seeds
        maxTokens: 2048,
      });
      
      // Get quality score for this run
      // For simplicity, use output length as proxy for consistency
      results.push(result.output.length);
    } catch (error) {
      console.error('Stability test failed:', error);
    }
  }
  
  if (results.length < 2) return 10; // Can't measure variance
  
  // Calculate coefficient of variation (inverse = stability)
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const variance = results.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / results.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0; // Coefficient of variation
  
  // Convert to 0-10 score (lower CV = higher stability)
  const stabilityScore = Math.max(0, Math.min(10, 10 * (1 - cv)));
  return stabilityScore;
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
  adapter: any
): Promise<{ passed: boolean; score: number }> {
  const evaluationPrompt = `SYSTEM: You are a strict evaluator. Return ONLY a JSON object.
USER: Rubric (1..10):
- Task completion accuracy
- Format compliance
- Hallucination avoidance
- Brevity & clarity

Given:
PROMPT (candidate): <<<
${candidatePrompt}
>>>
INPUT (test): <<<
${testPrompt}
>>>
OUTPUT (model): <<<
${modelOutput}
>>>

Return:
{"score": <number 1..10>, "justification": "<one sentence>"}`;

  try {
    const result = await adapter.call({
      model: serviceModel.model,
      prompt: evaluationPrompt,
      temperature: 0.3,
      maxTokens: 500,
    });
    
    // Parse JSON response
    const parsed = JSON.parse(result.output);
    const score = Math.max(0, Math.min(10, parsed.score || 0));
    
    return {
      passed: score >= 7,
      score,
    };
  } catch (error) {
    console.error('LLM grading failed:', error);
    // Fallback to neutral score
    return { passed: false, score: 5 };
  }
}

