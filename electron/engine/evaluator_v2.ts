/**
 * Evaluation Engine - V2 Complete Rewrite
 * 
 * Clean architecture:
 * 1. startEvaluation: Setup + create shell nodes + send to UI + return immediately
 * 2. mutatePopulationInBackground: Async mutation of nodes 1+ 
 * 3. evaluationLoop: Process nodes, run tests, calculate fitness
 * 4. moveToNextGeneration: Selection + variation operators
 * 
 * Real-time streaming: Every state change immediately sent via IPC
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  UUID,
  EvaluationConfig,
  EvaluationRun,
  CandidateNode,
  TestResult,
  ModelRef,
  ChangeLogLine,
} from '../../src/types/index.js';
import { createShellPopulation, mutateNode, crossoverNodes, metaPromptNode } from './operators_v2.js';
import { getProviderAdapter } from '../providers/index.js';
import { BrowserWindow } from 'electron';
import { initGlobalSemaphore } from './semaphore.js';
import { calculateFitness } from './fitness.js';
import { getDatabase } from '../database/init.js';

interface EvaluationState {
  run: EvaluationRun;
  config: EvaluationConfig;
  status: 'running' | 'paused' | 'stopped';
  currentGeneration: number;
  queue: CandidateNode[];
  inProgress: Set<UUID>;
  cache: Map<string, TestResult[]>;
  lineageHistory: Map<UUID, { bestFitness: number; stagnantGenerations: number }>;
  operatorEffectiveness: {
    mutation: { totalDelta: number; count: number };
    crossover: { totalDelta: number; count: number };
    meta: { totalDelta: number; count: number };
    param: { totalDelta: number; count: number };
  };
}

// Active evaluations map
const activeEvaluations = new Map<UUID, EvaluationState>();

/**
 * Send IPC update to renderer
 */
function sendUpdate(runId: UUID, data: any): void {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    windows[0].webContents.send(`eval:updates:${runId}`, data);
  }
}

/**
 * Track service model costs
 */
function trackServiceCost(
  state: EvaluationState,
  usd: number,
  tokens: { prompt: number; completion: number }
): void {
  state.run.totals.tokensPrompt += tokens.prompt;
  state.run.totals.tokensCompletion += tokens.completion;
  state.run.totals.usd += usd;
  state.run.totals.calls++;
}

/**
 * Main entry point: Start evaluation
 * Returns immediately after sending shell nodes to UI
 */
export async function startEvaluation(
  runId: UUID,
  config: EvaluationConfig,
  run: EvaluationRun
): Promise<void> {
  console.log(`[Evaluator] Starting evaluation ${runId.slice(0, 8)}`);
  
  if (activeEvaluations.has(runId)) {
    throw new Error('Evaluation already running');
  }
  
  // Initialize global semaphore
  const globalLimit = config.parallelLimit || 5;
  initGlobalSemaphore(globalLimit);
  console.log(`[Evaluator] Global API limit: ${globalLimit}`);
  
  // Initialize state
  const state: EvaluationState = {
    run: {
      ...run,
      generations: [[]],
      status: 'running',
    },
    config,
    status: 'running',
    currentGeneration: 0,
    queue: [],
    inProgress: new Set(),
    cache: new Map(),
    lineageHistory: new Map(),
    operatorEffectiveness: {
      mutation: { totalDelta: 0, count: 0 },
      crossover: { totalDelta: 0, count: 0 },
      meta: { totalDelta: 0, count: 0 },
      param: { totalDelta: 0, count: 0 },
    },
  };
  
  activeEvaluations.set(runId, state);
  
  // Send running status
  sendUpdate(runId, { type: 'status', status: 'running' });
  console.log(`[Evaluator] Status sent: running`);
  
  // Create shell population (synchronous, fast)
  console.log(`[Evaluator] Creating shell population...`);
  const shellNodes = createShellPopulation(config);
  console.log(`[Evaluator] Created ${shellNodes.length} shell nodes`);
  
  // Add all shell nodes to generation 0
  state.run.generations[0] = shellNodes;
  
  // Send ALL shell nodes to UI immediately
  for (const node of shellNodes) {
    console.log(`[Evaluator] Sending shell node ${node.id.slice(0, 8)}, status=${node.status}`);
    sendUpdate(runId, { type: 'node_created', node });
  }
  
  console.log(`[Evaluator] All ${shellNodes.length} shell nodes sent to UI`);
  
  // Start background mutation (non-blocking)
  mutatePopulationInBackground(runId, state);
  
  console.log(`[Evaluator] startEvaluation returning (mutation in background)`);
}

/**
 * Mutate nodes 1+ in background, then start evaluation loop
 */
async function mutatePopulationInBackground(
  runId: UUID,
  state: EvaluationState
): Promise<void> {
  console.log(`[Evaluator] Starting background mutation...`);
  
  const shellNodes = state.run.generations[0];
  const nodesToMutate = shellNodes.filter((_, i) => i > 0); // Skip first (baseline)
  
  console.log(`[Evaluator] Mutating ${nodesToMutate.length} nodes in parallel...`);
  
  const mutationPromises = nodesToMutate.map(async (node) => {
    try {
      console.log(`[Evaluator] Mutating node ${node.id.slice(0, 8)}...`);
      
      const result = await mutateNode(shellNodes[0].prompt, state.config);
      
      // Update node
      node.prompt = result.prompt;
      node.changeLog = result.changeLog;
      node.status = 'awaiting';
      
      // Track costs
      state.run.totals.tokensPrompt += result.cost.promptTokens;
      state.run.totals.tokensCompletion += result.cost.completionTokens;
      state.run.totals.usd += result.cost.usd;
      state.run.totals.calls += result.cost.calls;
      
      // Send totals update
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      
      // Update in state
      const index = state.run.generations[0].findIndex(n => n.id === node.id);
      if (index !== -1) {
        state.run.generations[0][index] = node;
      }
      
      console.log(`[Evaluator] Mutation complete for ${node.id.slice(0, 8)}`);
      
      // Send update
      sendUpdate(runId, { type: 'node_updated', node });
    } catch (error) {
      console.error(`[Evaluator] Mutation failed for ${node.id.slice(0, 8)}:`, error);
      
      // Mark as failed
      node.status = 'failed';
      node.error = `Mutation failed: ${error instanceof Error ? error.message : String(error)}`;
      
      // Send error update
      sendUpdate(runId, { type: 'node_updated', node });
    }
  });
  
  try {
    await Promise.all(mutationPromises);
    
    console.log(`[Evaluator] All mutations complete`);
    
    // Send population ready event
    sendUpdate(runId, { type: 'population_ready' });
    
    // Add awaiting nodes to queue
    state.queue = state.run.generations[0].filter(n => n.status === 'awaiting');
    console.log(`[Evaluator] Queue initialized with ${state.queue.length} nodes`);
    console.log(`[Evaluator] Node statuses:`, state.run.generations[0].map(n => `${n.id.slice(0, 8)}=${n.status}`));
    
    // Start evaluation loop
    if (state.status === 'running') {
      console.log(`[Evaluator] Starting evaluation loop...`);
      evaluationLoop(runId);
    } else {
      console.log(`[Evaluator] NOT starting evaluation loop, status=${state.status}`);
    }
  } catch (error) {
    console.error(`[Evaluator] Background mutation error:`, error);
    sendUpdate(runId, { type: 'error', message: `Background mutation failed: ${error}` });
  }
}

/**
 * Main evaluation loop
 */
async function evaluationLoop(runId: UUID): Promise<void> {
  const state = activeEvaluations.get(runId);
  if (!state) {
    console.log(`[Evaluator] Evaluation loop called but state not found for ${runId.slice(0, 8)}`);
    return;
  }
  
  console.log(`[Evaluator] Evaluation loop started for ${runId.slice(0, 8)}`);
  console.log(`[Evaluator] Queue length: ${state.queue.length}, InProgress: ${state.inProgress.size}`);
  console.log(`[Evaluator] Call stack:`, new Error().stack);
  
  while (state.queue.length > 0 && state.status === 'running') {
    // Check stopping conditions
    if (shouldStop(state)) {
      finishEvaluation(runId, state);
      return;
    }
    
    // Process next batch of nodes in parallel (up to parallelLimit)
    // Global semaphore will ensure we don't exceed total API concurrency
    const batch = state.queue.splice(0, state.config.parallelLimit);
    
    console.log(`[Evaluator] Processing batch of ${batch.length} nodes in parallel`);
    
    // Process all nodes in batch in parallel
    await Promise.all(batch.map(node => processNode(runId, node, state)));
    
    // Check if we were paused during the batch
    if (state.status === 'pausing') {
      console.log(`[Evaluator] Pause detected, exiting loop`);
      break;
    }
    
    // Check if generation is complete
    const currentGen = state.run.generations[state.currentGeneration];
    const allFinished = currentGen.every(n => 
      n.status === 'finished' || n.status === 'failed' || n.status === 'skipped'
    );
    
    if (allFinished && state.queue.length === 0) {
      console.log(`[Evaluator] Generation ${state.currentGeneration} complete`);
      
      // Check stopping conditions again
      if (shouldStop(state)) {
        finishEvaluation(runId, state);
        return;
      }
      
      // Check if we would exceed maxGenerations by creating the next one
      if (state.config.targets.maxGenerations) {
        if (state.currentGeneration + 1 >= state.config.targets.maxGenerations) {
          console.log(`[Evaluator] Reached max generations (${state.config.targets.maxGenerations})`);
          state.run.stopReason = 'target';
          finishEvaluation(runId, state);
          return;
        }
      }
      
      // Move to next generation
      await moveToNextGeneration(runId, state);
    }
  }
  
  console.log(`[Evaluator] Evaluation loop exited (status=${state.status}, queue=${state.queue.length}, inProgress=${state.inProgress.size})`);
  
  // If we exited because of pause, wait for any remaining in-progress nodes
  if (state.status === 'pausing') {
    console.log(`[Evaluator] Pausing... waiting for ${state.inProgress.size} in-progress nodes to complete`);
    
    // Wait for all in-progress nodes to finish
    while (state.inProgress.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`[Evaluator] All in-progress nodes completed, now fully paused`);
    state.status = 'paused';
    state.run.status = 'paused';
    sendUpdate(runId, { type: 'status', status: 'paused' });
  } else if (state.status === 'running') {
    // Loop exited naturally (queue empty)
    finishEvaluation(runId, state);
  }
}

/**
 * Process a single node: run tests, calculate fitness
 */
async function processNode(
  runId: UUID,
  node: CandidateNode,
  state: EvaluationState
): Promise<void> {
  console.log(`[Evaluator] Processing node ${node.id.slice(0, 8)}`);
  
  node.status = 'in_progress';
  node.timings = { startedAt: Date.now() };
  state.inProgress.add(node.id);
  
  sendUpdate(runId, { type: 'node_updated', node });
  
  try {
    // Run all tests
    node.tests = await runTests(runId, node, state);
    
    // Mark as finished to calculate latency
    node.timings.finishedAt = Date.now();
    
    // Calculate cost and latency from test results
    const { getModelCost } = await import('../providers/costs.js');
    const costEntry = await getModelCost(node.params.model);
    console.log(`[processNode] Cost entry for ${node.params.model.provider}/${node.params.model.model}:`, costEntry);
    
    let totalCost = 0;
    for (const test of node.tests) {
      if (costEntry) {
        const promptCost = (test.promptTokens / 1000) * costEntry.promptUSDper1k;
        const completionCost = (test.completionTokens / 1000) * costEntry.completionUSDper1k;
        console.log(`[processNode] Test ${test.testId}: prompt ${test.promptTokens} tokens = $${promptCost.toFixed(6)}, completion ${test.completionTokens} tokens = $${completionCost.toFixed(6)}`);
        totalCost += promptCost + completionCost;
      }
    }
    console.log(`[processNode] Total cost for node ${node.id}: $${totalCost}`);
    const avgLatency = node.timings.finishedAt - (node.timings.startedAt || 0);
    
    // Safety guardrails (if enabled)
    let safetyScore: number | undefined = undefined;
    if (state.config.fitness.weights.safety && state.config.fitness.guardrails && state.config.fitness.guardrails.length > 0) {
      const { evaluateSafetyGuardrails } = await import('./fitness.js');
      const serviceAdapter = getProviderAdapter(state.config.serviceModel.provider);
      const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;
      
      // Collect all outputs from tests
      const outputs = node.tests.map(t => t.outputText || '').join('\n\n');
      
      const safetyResult = await evaluateSafetyGuardrails(
        outputs,
        state.config.fitness.guardrails,
        state.config.serviceModel,
        serviceAdapter,
        maxTokens
      );
      
      safetyScore = safetyResult.score;
      
      // Track service model costs from safety checks
      state.run.totals.tokensPrompt += safetyResult.totalPromptTokens;
      state.run.totals.tokensCompletion += safetyResult.totalCompletionTokens;
      state.run.totals.usd += safetyResult.totalCost;
      state.run.totals.calls += safetyResult.calls;
      
      sendUpdate(runId, {
        type: 'totals',
        totals: state.run.totals,
        cacheHits: state.run.cacheHits,
      });
    }
    
    // Stability (if enabled)
    let stabilityScore: number | undefined = undefined;
    if (state.config.fitness.weights.stability) {
      const { calculateStabilityAcrossSeeds } = await import('./fitness.js');
      const adapter = getProviderAdapter(node.params.model.provider);
      
      const stabilityResult = await calculateStabilityAcrossSeeds(
        node.prompt,
        node.params,
        state.config,
        state.config.testSet,
        adapter,
        3 // numSeeds
      );
      
      stabilityScore = stabilityResult.score;
      
      // Track candidate model costs from stability runs
      state.run.totals.tokensPrompt += stabilityResult.totalPromptTokens;
      state.run.totals.tokensCompletion += stabilityResult.totalCompletionTokens;
      state.run.totals.usd += stabilityResult.totalCost;
      state.run.totals.calls += stabilityResult.calls;
      
      sendUpdate(runId, {
        type: 'totals',
        totals: state.run.totals,
        cacheHits: state.run.cacheHits,
      });
    }
    
    // Set metrics before calculating fitness
    node.metrics = {
      costUSD: totalCost,
      latencyMs: avgLatency,
      safety: safetyScore,
      stability: stabilityScore,
    };
    
    // Calculate fitness (uses node.tests and node.metrics)
    const fitnessResult = calculateFitness(node, state.config);
    node.metrics = {
      quality: fitnessResult.quality,
      safety: safetyScore,
      costUSD: totalCost,
      latencyMs: avgLatency,
      stability: stabilityScore,
      fitness: fitnessResult.fitness,
    };
    
    node.status = 'finished';
    
    console.log(`[Evaluator] Node ${node.id.slice(0, 8)} finished, quality=${fitnessResult.quality.toFixed(2)}, cost=$${totalCost.toFixed(4)}, latency=${avgLatency}ms, fitness=${node.metrics.fitness?.toFixed(2)}`);
    
    // Track operator effectiveness
    const operatorType = (node as any)._operatorType;
    const parentFitness = (node as any)._parentFitness;
    if (operatorType && parentFitness !== undefined && node.metrics?.fitness !== undefined) {
      const fitnessDelta = node.metrics.fitness - parentFitness;
      state.operatorEffectiveness[operatorType].totalDelta += fitnessDelta;
      state.operatorEffectiveness[operatorType].count++;
      
      const avgDelta = state.operatorEffectiveness[operatorType].totalDelta / state.operatorEffectiveness[operatorType].count;
      console.log(`[Evaluator] Operator effectiveness [${operatorType}]: avgΔ=${avgDelta.toFixed(3)} (count=${state.operatorEffectiveness[operatorType].count})`);
    }
  } catch (error) {
    console.error(`[Evaluator] Node ${node.id.slice(0, 8)} failed:`, error);
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);
  }
  
  state.inProgress.delete(node.id);
  
  sendUpdate(runId, { type: 'node_updated', node });
}

/**
 * Run all tests for a node
 */
async function runTests(
  runId: UUID,
  node: CandidateNode,
  state: EvaluationState
): Promise<TestResult[]> {
  const adapter = getProviderAdapter(node.params.model.provider);
  const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;
  
  // Generate cache key: hash(prompt, model, temperature, testSet signature)
  const crypto = await import('crypto');
  const testSetSig = state.config.testSet.map(t => t.id).join(',');
  const cacheKey = crypto.createHash('sha256')
    .update(`${node.prompt}|${node.params.model.provider}/${node.params.model.model}|${node.params.temperature}|${testSetSig}`)
    .digest('hex');

  // Check cache
  if (state.cache.has(cacheKey)) {
    console.log(`[Evaluator] Cache hit for node ${node.id.slice(0, 8)}`);
    state.run.cacheHits++;
    sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    return state.cache.get(cacheKey)!;
  }
  
  // Run all tests in parallel
  const testPromises = state.config.testSet.map(async (test) => {
    const combinedPrompt = `${node.prompt}\n\n${test.prompt}`;
    
    const result = await adapter.call({
      model: node.params.model.model,
      prompt: combinedPrompt,
      temperature: node.params.temperature,
      seed: node.params.seed,
      maxTokens,
    });
    
    // Update totals immediately for candidate model call
    state.run.totals.tokensPrompt += result.promptTokens;
    state.run.totals.tokensCompletion += result.completionTokens;
    state.run.totals.usd += result.usd;
    state.run.totals.calls++;
    
    sendUpdate(runId, {
      type: 'totals',
      totals: state.run.totals,
      cacheHits: state.run.cacheHits,
    });
    
    // Grade the output using LLM grading
    let score = 5.0; // Default fallback
    let passed = false;
    let llmGradeReasoning: string | undefined;
    
    if (test.mode === 'llm_grade') {
      const { evaluateTestResultLLM } = await import('./fitness.js');
      const serviceAdapter = getProviderAdapter(state.config.serviceModel.provider);
      
      const gradingResult = await evaluateTestResultLLM(
        test,
        node.prompt,
        test.prompt,
        result.output,
        state.config.serviceModel,
        serviceAdapter,
        maxTokens
      );
      
      score = gradingResult.score;
      passed = gradingResult.passed;
      llmGradeReasoning = gradingResult.reasoning;
      
      // Track service model costs from LLM grading
      state.run.totals.tokensPrompt += gradingResult.promptTokens;
      state.run.totals.tokensCompletion += gradingResult.completionTokens;
      state.run.totals.usd += gradingResult.usd;
      state.run.totals.calls++;
      
      sendUpdate(runId, {
        type: 'totals',
        totals: state.run.totals,
        cacheHits: state.run.cacheHits,
      });
    } else if (test.mode === 'exact_match') {
      // Exact match scoring with distance metrics
      if (!test.expected) {
        console.warn(`[Test] exact_match test ${test.id} has no expected value`);
        score = 0;
        passed = false;
      } else if (test.grading?.strictZeroOnDeviation) {
        // Strict mode: 0 or 10 only
        const isExactMatch = result.output.trim() === test.expected.trim();
        score = isExactMatch ? 10 : 0;
        passed = isExactMatch;
      } else {
        // Distance-based grading
        const distanceMetric = test.grading?.distanceMetric || 'levenshtein';
        
        if (distanceMetric === 'levenshtein') {
          const { levenshteinScore0to10 } = await import('../../src/utils/distance.js');
          score = levenshteinScore0to10(test.expected, result.output);
          passed = score >= 7; // 70% threshold
        } else if (distanceMetric === 'json_diff') {
          const { jsonDiffScore0to10 } = await import('../../src/utils/distance.js');
          score = jsonDiffScore0to10(test.expected, result.output);
          passed = score >= 7;
        } else if (distanceMetric === 'numeric_abs') {
          const { numericAbsScore0to10 } = await import('../../src/utils/distance.js');
          score = numericAbsScore0to10(test.expected, result.output);
          passed = score >= 7;
        } else {
          console.warn(`[Test] Unknown distance metric: ${distanceMetric}`);
          score = 5.0;
          passed = false;
        }
      }
    }
    
    const testResult: TestResult = {
      testId: test.id,
      passed,
      score,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      outputText: result.output,
      llmGradeReasoning,
    };
    
    return testResult;
  });
  
  const results = await Promise.all(testPromises);
  
  // Store in cache
  state.cache.set(cacheKey, results);
  console.log(`[Evaluator] Cached results for node ${node.id.slice(0, 8)}`);
  
  return results;
}

/**
 * Check if evaluation should stop
 */
function shouldStop(state: EvaluationState): boolean {
  const config = state.config;
  const run = state.run;
  
  // Time limit
  if (config.targets.timeLimitMs) {
    const elapsed = Date.now() - run.startedAt;
    if (elapsed >= config.targets.timeLimitMs) {
      state.run.stopReason = 'time';
      return true;
    }
  }
  
  // Budget limit
  if (config.targets.budgetUSD) {
    if (run.totals.usd >= config.targets.budgetUSD) {
      state.run.stopReason = 'budget';
      return true;
    }
  }
  
  // Target fitness
  if (config.targets.targetFitness) {
    const bestFitness = Math.max(
      ...state.run.generations[state.currentGeneration]
        .filter(n => n.metrics?.fitness !== undefined)
        .map(n => n.metrics!.fitness!)
    );
    
    if (bestFitness >= config.targets.targetFitness) {
      state.run.stopReason = 'target';
      return true;
    }
  }
  
  // Max generations (counting from 0, so if maxGenerations=3, we want gen 0, 1, 2 only)
  if (config.targets.maxGenerations) {
    if (state.currentGeneration >= config.targets.maxGenerations) {
      state.run.stopReason = 'target';
      return true;
    }
  }
  
  return false;
}

/**
 * Move to next generation: selection + variation
 */
async function moveToNextGeneration(
  runId: UUID,
  state: EvaluationState
): Promise<void> {
  console.log(`[Evaluator] Moving to generation ${state.currentGeneration + 1}`);
  
  // Select top performers
  const currentGen = state.run.generations[state.currentGeneration];
  const sorted = currentGen
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!);
  
  let topPerformers: CandidateNode[];
  if (state.config.selection.policy === 'topp') {
    // Top-P selection
    const topP = state.config.selection.topP || 0.5;
    const totalFitness = sorted.reduce((sum, n) => sum + (n.metrics?.fitness || 0), 0);
    let cumulative = 0;
    let cutoff = 0;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += (sorted[i].metrics?.fitness || 0) / totalFitness;
      if (cumulative >= topP) {
        cutoff = i + 1;
        break;
      }
    }
    topPerformers = sorted.slice(0, Math.max(1, cutoff));
    console.log(`[Evaluator] Selected ${topPerformers.length} top performers (Top-P=${topP})`);
  } else {
    // Top-K selection
    const topK = state.config.selection.topK || Math.ceil(sorted.length * 0.4);
    topPerformers = sorted.slice(0, topK);
    console.log(`[Evaluator] Selected ${topPerformers.length} top performers (Top-K=${topK})`);
  }
  
  if (topPerformers.length === 0) {
    console.log(`[Evaluator] No valid performers, stopping`);
    state.run.stopReason = 'exhausted';
    return;
  }
  
  // Create next generation
  state.currentGeneration++;
  state.run.generations.push([]);
  
  const newGenNodes: CandidateNode[] = [];
  const mutationFactor = state.config.operators.mutationFactor;
  const crossoverFactor = state.config.operators.crossoverFactor;
  
  // Apply variation operators
  const metaPromptShare = state.config.operators.metaPrompting?.enabled ? (state.config.operators.metaPrompting.share || 0.2) : 0;
  const paramVariationShare = state.config.operators.paramVariation?.enabled ? (state.config.operators.paramVariation.share || 0.2) : 0;
  
  for (let i = 0; i < topPerformers.length; i++) {
    const parent = topPerformers[i];
    const model = state.config.enabledModels[i % state.config.enabledModels.length];
    const parentFitness = parent.metrics?.fitness || 0;
    
    let prompt = parent.prompt;
    let changeLog: ChangeLogLine[] = [];
    let temperature = 0.7; // Default
    let operatorType: 'mutation' | 'crossover' | 'meta' | 'param' | null = null;
    
    const rand = Math.random();
    
    try {
      if (rand < metaPromptShare && state.config.operators.metaPrompting?.enabled) {
        // Meta-prompting (targeted edits based on failures)
        const result = await metaPromptNode(parent, state.config, currentGen);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'meta';
        
        // Track costs
        state.run.totals.tokensPrompt += result.cost.promptTokens;
        state.run.totals.tokensCompletion += result.cost.completionTokens;
        state.run.totals.usd += result.cost.usd;
        state.run.totals.calls += result.cost.calls;
        
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
        console.log(`[Evaluator] Meta-prompting for gen ${state.currentGeneration} node ${i}`);
      } else if (rand < metaPromptShare + crossoverFactor && topPerformers.length > 1) {
        // Crossover
        const parentB = topPerformers[Math.floor(Math.random() * topPerformers.length)];
        const result = await crossoverNodes(parent, parentB, state.config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'crossover';
        
        // Track costs
        state.run.totals.tokensPrompt += result.cost.promptTokens;
        state.run.totals.tokensCompletion += result.cost.completionTokens;
        state.run.totals.usd += result.cost.usd;
        state.run.totals.calls += result.cost.calls;
        
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
        console.log(`[Evaluator] Crossover for gen ${state.currentGeneration} node ${i}`);
      } else if (rand < metaPromptShare + crossoverFactor + mutationFactor) {
        // Mutation
        const result = await mutateNode(parent.prompt, state.config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'mutation';
        
        // Track costs
        state.run.totals.tokensPrompt += result.cost.promptTokens;
        state.run.totals.tokensCompletion += result.cost.completionTokens;
        state.run.totals.usd += result.cost.usd;
        state.run.totals.calls += result.cost.calls;
        
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
        console.log(`[Evaluator] Mutation for gen ${state.currentGeneration} node ${i}`);
      } else {
        // Carry forward
        changeLog = [{ label: 'MUTATION', text: 'Carried forward (no variation)' }];
        console.log(`[Evaluator] Carry forward for gen ${state.currentGeneration} node ${i}`);
      }
    } catch (error) {
      console.error(`[Evaluator] Operator failed for gen ${state.currentGeneration} node ${i}:`, error);
      // Fallback to parent
      prompt = parent.prompt;
      changeLog = [{ label: 'MUTATION', text: 'Operator failed, using parent' }];
    }
    
    // Parameter variation (temperature)
    if (state.config.operators.paramVariation?.enabled && Math.random() < paramVariationShare) {
      const tempConfig = state.config.operators.paramVariation.temperature;
      const min = tempConfig.min || 0.3;
      const max = tempConfig.max || 1.5;
      temperature = min + Math.random() * (max - min);
      changeLog.push({ label: 'PARAM', text: `Temperature varied to ${temperature.toFixed(2)}` });
      if (!operatorType) operatorType = 'param';
      console.log(`[Evaluator] Parameter variation for gen ${state.currentGeneration} node ${i}: temp=${temperature.toFixed(2)}`);
    }
    
    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: state.currentGeneration,
      lineageParents: [parent.id],
      status: 'awaiting',
      prompt,
      params: { model, temperature },
      changeLog,
    };
    
    newGenNodes.push(newNode);
    
    // Track operator effectiveness (will update after this node is evaluated)
    // Store parent fitness and operator type for later delta calculation
    (newNode as any)._operatorType = operatorType;
    (newNode as any)._parentFitness = parentFitness;
  }
  
  // Add to generation and queue
  state.run.generations[state.currentGeneration] = newGenNodes;
  state.queue.push(...newGenNodes);
  
  // Send generation created event
  sendUpdate(runId, {
    type: 'generation_created',
    generation: state.currentGeneration,
    nodes: newGenNodes,
  });
  
  console.log(`[Evaluator] Generation ${state.currentGeneration} created with ${newGenNodes.length} nodes`);
}

/**
 * Finish evaluation
 */
function finishEvaluation(runId: UUID, state: EvaluationState): void {
  console.log(`[Evaluator] Finishing evaluation, reason=${state.run.stopReason}`);
  
  state.status = 'stopped';
  state.run.status = 'finished';
  state.run.finishedAt = Date.now();
  
  // Persist to database
  const db = getDatabase();
  db.prepare(`
    UPDATE evaluation_runs
    SET run_json = ?
    WHERE id = ?
  `).run(JSON.stringify(state.run), runId);
  
  // Send final updates
  sendUpdate(runId, { type: 'status', status: 'finished' });
  sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
  
  // Remove from active evaluations
  activeEvaluations.delete(runId);
  
  console.log(`[Evaluator] Evaluation ${runId.slice(0, 8)} finished`);
}

/**
 * Pause evaluation
 */
export function pauseEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'paused';
    state.run.status = 'paused';
    sendUpdate(runId, { type: 'status', status: 'paused' });
  }
}

/**
 * Resume evaluation
 */
export function resumeEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    console.log(`[Evaluator] Resume requested for ${runId.slice(0, 8)}, queue=${state.queue.length}, inProgress=${state.inProgress.size}`);
    
    state.status = 'running';
    state.run.status = 'running';
    sendUpdate(runId, { type: 'status', status: 'running' });
    
    // Only start loop if there's work to do
    // If queue is empty, the background mutation may still be in progress
    if (state.queue.length > 0 || state.inProgress.size > 0) {
      console.log(`[Evaluator] Starting evaluation loop on resume`);
      evaluationLoop(runId);
    } else {
      console.log(`[Evaluator] No work to resume yet (mutations may still be in progress)`);
      // The loop will be started when mutations complete
    }
  }
}

/**
 * Stop evaluation
 */
export function stopEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'stopped';
    state.run.stopReason = 'manual';
    finishEvaluation(runId, state);
  }
}

