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
      
      const { prompt, changeLog } = await mutateNode(shellNodes[0].prompt, state.config);
      
      // Update node
      node.prompt = prompt;
      node.changeLog = changeLog;
      node.status = 'awaiting';
      
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
  
  await Promise.all(mutationPromises);
  
  console.log(`[Evaluator] All mutations complete`);
  
  // Send population ready event
  sendUpdate(runId, { type: 'population_ready' });
  
  // Add awaiting nodes to queue
  state.queue = state.run.generations[0].filter(n => n.status === 'awaiting');
  console.log(`[Evaluator] Queue initialized with ${state.queue.length} nodes`);
  
  // Start evaluation loop
  if (state.status === 'running') {
    console.log(`[Evaluator] Starting evaluation loop...`);
    evaluationLoop(runId);
  }
}

/**
 * Main evaluation loop
 */
async function evaluationLoop(runId: UUID): Promise<void> {
  const state = activeEvaluations.get(runId);
  if (!state) return;
  
  console.log(`[Evaluator] Evaluation loop started`);
  
  while (state.queue.length > 0 && state.status === 'running') {
    // Check stopping conditions
    if (shouldStop(state)) {
      finishEvaluation(runId, state);
      return;
    }
    
    // Process next batch of nodes (up to parallelLimit)
    const batch = state.queue.splice(0, state.config.parallelLimit);
    
    console.log(`[Evaluator] Processing batch of ${batch.length} nodes`);
    
    await Promise.all(batch.map(node => processNode(runId, node, state)));
    
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
  
  console.log(`[Evaluator] Evaluation loop finished`);
  finishEvaluation(runId, state);
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
    const { getCostForModel } = await import('../providers/costs.js');
    let totalCost = 0;
    for (const test of node.tests) {
      const costEntry = getCostForModel(node.params.model);
      if (costEntry) {
        totalCost += (test.promptTokens / 1000) * costEntry.prompt_usd_per_1k;
        totalCost += (test.completionTokens / 1000) * costEntry.completion_usd_per_1k;
      }
    }
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
    };
    
    return testResult;
  });
  
  return Promise.all(testPromises);
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
  
  const topK = state.config.selection.topK || Math.ceil(sorted.length * 0.4);
  const topPerformers = sorted.slice(0, topK);
  
  console.log(`[Evaluator] Selected ${topPerformers.length} top performers`);
  
  if (topPerformers.length === 0) {
    console.log(`[Evaluator] No valid performers, stopping`);
    state.run.stopReason = 'exhausted';
    return;
  }
  
  // Create next generation
  state.currentGeneration++;
  state.run.generations.push([]);
  
  const newGenNodes: CandidateNode[] = [];
  
  // TODO: Implement variation operators (mutations, crossover)
  // For now, just carry forward top performers
  for (let i = 0; i < topPerformers.length; i++) {
    const parent = topPerformers[i];
    const model = state.config.enabledModels[i % state.config.enabledModels.length];
    
    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: state.currentGeneration,
      lineageParents: [parent.id],
      status: 'awaiting',
      prompt: parent.prompt, // TODO: mutate
      params: { model, temperature: 0.7 },
      changeLog: [{ label: 'MUTATION', text: 'Carried forward (TODO: implement mutation)' }],
    };
    
    newGenNodes.push(newNode);
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
    state.status = 'running';
    state.run.status = 'running';
    sendUpdate(runId, { type: 'status', status: 'running' });
    evaluationLoop(runId);
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

