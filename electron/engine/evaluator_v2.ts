/**
 * Evaluation Engine - V2 Complete Rewrite
 * 
 * Clean architecture:
 * 1. startEvaluation: Setup + create shell nodes + send to UI + return immediately
 * 2. mutatePopulationInBackground: Async mutation of nodes 1+ 
 * 3. evaluationLoop: Process nodes, run tests, calculate fitness
 * 4. moveToNextGeneration: Delegates to generation.ts for selection and variation
 * 
 * Real-time streaming: Every state change immediately sent via IPC
 * 
 * Note: Generation creation logic moved to generation.ts
 * Note: Genetic operators in operators_v2.ts, mutations.ts, metaprompting.ts
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
import { createShellPopulation, mutateNode } from './operators_v2.js';
import { selectTopPerformers, createNextGeneration } from './generation.js';
import { getProviderAdapter } from '../providers/index.js';
import { BrowserWindow } from 'electron';
import { initGlobalSemaphore } from './semaphore.js';
import { calculateFitness } from './fitness.js';
import { getDatabase } from '../database/init.js';

interface EvaluationState {
  run: EvaluationRun;
  config: EvaluationConfig;
  status: 'running' | 'pausing' | 'paused' | 'stopped';
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
    model: { totalDelta: number; count: number };
    elite: { totalDelta: number; count: number };
  };
  pausedAt?: number; // Timestamp when paused (if currently paused)
  totalPausedMs: number; // Total time spent paused
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
 * Check if relative mode is enabled for any metric
 */
function isRelativeModeEnabled(config: EvaluationConfig): boolean {
  const costRelative = config.fitness.costNorm?.mode === 'relative' && (config.fitness.weights.cost || 0) > 0;
  const latencyRelative = config.fitness.latencyNorm?.mode === 'relative' && (config.fitness.weights.latency || 0) > 0;
  return costRelative || latencyRelative;
}

/**
 * Recalculate fitness for all finished nodes using current max values (for relative mode)
 */
function recalculateAllFitness(runId: UUID, state: EvaluationState): void {
  // Collect all finished nodes across all generations
  const finishedNodes: CandidateNode[] = [];
  for (const generation of state.run.generations) {
    for (const node of generation) {
      if (node.status === 'finished' && node.metrics) {
        finishedNodes.push(node);
      }
    }
  }
  
  if (finishedNodes.length === 0) return;
  
  // Calculate dynamic max values from all finished nodes
  let maxCost: number | undefined;
  let maxLatency: number | undefined;
  
  if (state.config.fitness.costNorm?.mode === 'relative' && (state.config.fitness.weights.cost || 0) > 0) {
    maxCost = Math.max(...finishedNodes.map(n => n.metrics?.costUSD || 0).filter(c => c > 0));
    console.log(`[Fitness Recalc] Dynamic max cost: $${maxCost.toFixed(6)} (from ${finishedNodes.length} nodes)`);
  }
  
  if (state.config.fitness.latencyNorm?.mode === 'relative' && (state.config.fitness.weights.latency || 0) > 0) {
    maxLatency = Math.max(...finishedNodes.map(n => n.metrics?.latencyMs || 0).filter(l => l > 0));
    console.log(`[Fitness Recalc] Dynamic max latency: ${maxLatency.toFixed(1)}ms (from ${finishedNodes.length} nodes)`);
  }
  
  // Recalculate fitness for all finished nodes
  let recalculated = 0;
  for (const node of finishedNodes) {
    const fitnessResult = calculateFitness(node, state.config, maxCost, maxLatency);
    if (node.metrics) {
      const oldFitness = node.metrics.fitness;
      node.metrics.fitness = fitnessResult.fitness;
      const fitnessChanged = Math.abs((oldFitness || 0) - fitnessResult.fitness) > 0.001;
      if (fitnessChanged) {
        recalculated++;
        console.log(`[Fitness Recalc] Node ${node.id.slice(0, 8)}: ${(oldFitness || 0).toFixed(3)} → ${fitnessResult.fitness.toFixed(3)}`);
      }
      // Always send update for all nodes to ensure UI is in sync
      sendUpdate(runId, { type: 'node_updated', node });
    }
  }
  
  console.log(`[Fitness Recalc] Sent updates for ${finishedNodes.length} nodes (${recalculated} changed)`);
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
      model: { totalDelta: 0, count: 0 },
      elite: { totalDelta: 0, count: 0 },
    },
    totalPausedMs: 0,
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
    
    // Handle pause request that occurred during mutations
    if (state.status === 'pausing') {
      console.log(`[Evaluator] Mutations complete, transitioning from 'pausing' to 'paused'`);
      state.status = 'paused';
      state.run.status = 'paused';
      state.run.totalPausedMs = state.totalPausedMs; // Update run object
      state.pausedAt = Date.now();
      state.run.pausedAt = state.pausedAt; // Send to frontend
      sendUpdate(runId, { type: 'status', status: 'paused', totalPausedMs: state.totalPausedMs, pausedAt: state.pausedAt });
      return;
    }
    
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
    
    // Check if we were paused during the batch (status can change externally)
    const currentStatus = state.status as EvaluationState['status'];
    if (currentStatus === 'pausing') {
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
    state.run.totalPausedMs = state.totalPausedMs; // Update run object
    state.pausedAt = Date.now(); // Record when actually paused
    state.run.pausedAt = state.pausedAt; // Send to frontend
    sendUpdate(runId, { type: 'status', status: 'paused', totalPausedMs: state.totalPausedMs, pausedAt: state.pausedAt });
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
  
  let skipFinalUpdate = false; // Will be set to true if we call recalculateAllFitness
  
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
    // Sum all test latencies (includes cached latencies from previous runs)
    const totalLatency = node.tests.reduce((sum, r) => sum + r.latencyMs, 0);
    
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
      latencyMs: totalLatency,
      safety: safetyScore,
      stability: stabilityScore,
    };
    
    // Calculate fitness (uses node.tests and node.metrics)
    // Note: Initial calculation uses absolute values if set, will be recalculated below if relative mode
    const fitnessResult = calculateFitness(node, state.config);
    node.metrics = {
      quality: fitnessResult.quality,
      safety: safetyScore,
      costUSD: totalCost,
      latencyMs: totalLatency,
      stability: stabilityScore,
      fitness: fitnessResult.fitness,
    };
    
    node.status = 'finished';
    
    console.log(`[Evaluator] Node ${node.id.slice(0, 8)} finished, quality=${fitnessResult.quality.toFixed(2)}, cost=$${totalCost.toFixed(4)}, latency=${totalLatency}ms, fitness=${node.metrics.fitness?.toFixed(2)}`);
    
    // If relative mode is enabled for cost or latency, recalculate fitness for ALL finished nodes
    // This will update node.metrics.fitness in place and send updates for all nodes
    skipFinalUpdate = isRelativeModeEnabled(state.config);
    if (skipFinalUpdate) {
      recalculateAllFitness(runId, state);
    }
    
    // Track operator effectiveness
    const operatorType = (node as any)._operatorType;
    const parentFitness = (node as any)._parentFitness;
    if (operatorType && parentFitness !== undefined && node.metrics?.fitness !== undefined) {
      // Check if this operator type is tracked
      if (state.operatorEffectiveness[operatorType as keyof typeof state.operatorEffectiveness]) {
        const fitnessDelta = node.metrics.fitness - parentFitness;
        state.operatorEffectiveness[operatorType].totalDelta += fitnessDelta;
        state.operatorEffectiveness[operatorType].count++;
        
        const avgDelta = state.operatorEffectiveness[operatorType].totalDelta / state.operatorEffectiveness[operatorType].count;
        console.log(`[Evaluator] Operator effectiveness [${operatorType}]: avgΔ=${avgDelta.toFixed(3)} (count=${state.operatorEffectiveness[operatorType].count})`);
      } else {
        console.warn(`[Evaluator] Unknown operator type: ${operatorType} (skipping effectiveness tracking)`);
      }
    }
  } catch (error) {
    console.error(`[Evaluator] Node ${node.id.slice(0, 8)} failed:`, error);
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);
  }
  
  state.inProgress.delete(node.id);
  
  // Only send update if we didn't already send it in recalculateAllFitness
  if (!skipFinalUpdate) {
    sendUpdate(runId, { type: 'node_updated', node });
  }
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
      latencyMs: result.latencyMs,
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
  
  // Time limit (excluding paused time)
  if (config.targets.timeLimitMs) {
    const wallClockElapsed = Date.now() - run.startedAt;
    const activeElapsed = wallClockElapsed - state.totalPausedMs;
    if (activeElapsed >= config.targets.timeLimitMs) {
      console.log(`[Evaluator] Time limit reached: ${activeElapsed}ms active (${wallClockElapsed}ms total, ${state.totalPausedMs}ms paused)`);
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
  const topPerformers = selectTopPerformers(currentGen, state.config);
  
  if (topPerformers.length === 0) {
    console.log(`[Evaluator] No valid performers, stopping`);
    state.run.stopReason = 'exhausted';
    return;
  }
  
  // Create next generation
  state.currentGeneration++;
  state.run.generations.push([]);
  
  const result = await createNextGeneration(
    topPerformers,
    currentGen,
    state.currentGeneration,
    state.config,
    state.run.generations // Pass all generations for elitism
  );
  
  const newGenNodes = result.newNodes;
  
  // Track costs
  state.run.totals.tokensPrompt += result.costTracking.promptTokens;
  state.run.totals.tokensCompletion += result.costTracking.completionTokens;
  state.run.totals.usd += result.costTracking.usd;
  state.run.totals.calls += result.costTracking.calls;
  
  sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
  
  // Add to generation and queue (elite nodes are already finished, don't re-queue them)
  state.run.generations[state.currentGeneration] = newGenNodes;
  const nodesToQueue = newGenNodes.filter(n => n.status !== 'finished');
  state.queue.push(...nodesToQueue);
  
  const numElites = newGenNodes.length - nodesToQueue.length;
  console.log(`[Evaluator] Queued ${nodesToQueue.length} nodes for evaluation (${numElites} elites already finished)`);
  
  // Send generation created event (includes all nodes, no need for individual node_created events)
  console.log(`[Evaluator] Sending generation_created event for gen ${state.currentGeneration} with ${newGenNodes.length} nodes`);
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
    console.log(`[Evaluator] Pause requested, setting status to 'pausing'`);
    state.status = 'pausing';
    state.run.status = 'pausing';
    sendUpdate(runId, { type: 'status', status: 'pausing' });
    // Note: pausedAt will be set when actually paused in the evaluation loop
  }
}

/**
 * Resume evaluation
 */
export function resumeEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    console.log(`[Evaluator] Resume requested for ${runId.slice(0, 8)}, queue=${state.queue.length}, inProgress=${state.inProgress.size}`);
    
    // Calculate pause duration and add to total
    if (state.pausedAt) {
      const pauseDuration = Date.now() - state.pausedAt;
      state.totalPausedMs += pauseDuration;
      state.run.totalPausedMs = state.totalPausedMs; // Update run object
      console.log(`[Evaluator] Pause duration: ${pauseDuration}ms, Total paused: ${state.totalPausedMs}ms`);
      state.pausedAt = undefined;
      state.run.pausedAt = undefined; // Clear from frontend
    }
    
    state.status = 'running';
    state.run.status = 'running';
    sendUpdate(runId, { type: 'status', status: 'running', totalPausedMs: state.totalPausedMs, pausedAt: undefined });
    
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

