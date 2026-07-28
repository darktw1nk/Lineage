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

import type {
  UUID,
  EvaluationConfig,
  EvaluationRun,
  CandidateNode,
  CandidateParams,
  TestCase,
  TestResult,
  ProviderAdapter,
} from '../types.js';
import { createHash } from 'crypto';
import { createShellPopulation, mutateNode } from './operators_v2.js';
import { selectTopPerformers, createNextGeneration } from './generation.js';
import { getProviderAdapter } from '../providers/index.js';
import { initGlobalSemaphore } from './semaphore.js';
import { rngFor } from './rng.js';
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
  operatorEffectiveness: Record<string, { totalDelta: number; count: number }>;
  fitnessTests: TestCase[];   // tests visible to evolution
  holdoutTests: TestCase[];   // reserved for the final generalization report
  samplesPerTest: number;     // resolved + clamped from config
  promptMode: 'system' | 'inline'; // resolved from config (default 'system')
  pairwiseEnabled: boolean;   // opt-in pairwise playoff
  pairwiseContenders: number; // resolved + clamped (2..8) from config
  pausedAt?: number; // Timestamp when paused (if currently paused)
  totalPausedMs: number; // Total time spent paused
  gradingTotal: number; // Total grading calls completed
  gradingFailures: number; // Grading calls that failed to parse JSON
}

// Active evaluations map
const activeEvaluations = new Map<UUID, EvaluationState>();

/**
 * Pluggable update sender. Defaults to a no-op; the host injects a real
 * sender via setSendUpdate() (Electron: BrowserWindow IPC; CLI: collector).
 */
let _sendUpdate: (runId: UUID, data: any) => void = () => {
  // No-op until the host injects a sender via setSendUpdate().
};

export function setSendUpdate(fn: (runId: UUID, data: any) => void): void {
  _sendUpdate = fn;
}

function sendUpdate(runId: UUID, data: any): void {
  _sendUpdate(runId, data);
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

  // Resolve the evaluation harness settings
  const rawSamples = config.samplesPerTest ?? 1;
  const samplesPerTest = Math.min(Math.max(Math.floor(rawSamples), 1), 10);
  if (samplesPerTest !== rawSamples) {
    console.warn(`[Evaluator] samplesPerTest clamped from ${rawSamples} to ${samplesPerTest}`);
  }
  const { partitionTestSet } = await import('./holdout.js');
  // Holdout split precedence: explicit holdoutSeed > run seed > 42
  const { fitnessTests, holdoutTests } = partitionTestSet(config.testSet, config.holdoutShare ?? 0, config.holdoutSeed ?? config.seed ?? 42);
  if (fitnessTests.length === 0) {
    throw new Error('Holdout configuration leaves no fitness tests');
  }
  if (holdoutTests.length > 0) {
    console.log(`[Evaluator] Holdout: ${holdoutTests.length} test(s) reserved (${holdoutTests.map(t => t.name).join(', ')})`);
  }
  const pairwiseEnabled = config.pairwise?.enabled === true;
  const rawContenders = config.pairwise?.contenders ?? 4;
  const pairwiseContenders = Math.min(Math.max(Math.floor(rawContenders), 2), 8);
  if (pairwiseEnabled && pairwiseContenders !== rawContenders) {
    console.warn(`[Playoff] contenders clamped from ${rawContenders} to ${pairwiseContenders}`);
  }

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
    operatorEffectiveness: {},
    fitnessTests,
    holdoutTests,
    samplesPerTest,
    promptMode: config.promptMode ?? 'system',
    pairwiseEnabled,
    pairwiseContenders,
    totalPausedMs: 0,
    gradingTotal: 0,
    gradingFailures: 0,
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
  
  // Skip mutation for manual mode - prompts are already specified
  if (state.config.population.fill === 'manual') {
    console.log(`[Evaluator] Manual mode detected, skipping mutations`);
    
    // All nodes are already 'awaiting', just add them to queue
    state.queue = shellNodes.filter(n => n.status === 'awaiting');
    console.log(`[Evaluator] Queue initialized with ${state.queue.length} nodes`);
    
    // Send population ready event
    sendUpdate(runId, { type: 'population_ready' });
    
    // Handle pause request that occurred during setup
    if (state.status === 'pausing') {
      console.log(`[Evaluator] Setup complete, transitioning from 'pausing' to 'paused'`);
      state.status = 'paused';
      state.run.status = 'paused';
      state.run.totalPausedMs = state.totalPausedMs;
      state.pausedAt = Date.now();
      state.run.pausedAt = state.pausedAt;
      sendUpdate(runId, { type: 'status', status: 'paused', totalPausedMs: state.totalPausedMs, pausedAt: state.pausedAt });
      return;
    }
    
    // Start evaluation loop
    if (state.status === 'running') {
      console.log(`[Evaluator] Starting evaluation loop...`);
      evaluationLoop(runId);
    }
    return;
  }
  
  const nodesToMutate = shellNodes.filter((_, i) => i > 0); // Skip first (baseline)
  
  console.log(`[Evaluator] Mutating ${nodesToMutate.length} nodes in parallel...`);
  
  const mutationPromises = nodesToMutate.map(async (node, k) => {
    try {
      console.log(`[Evaluator] Mutating node ${node.id.slice(0, 8)}...`);

      // k+1 = the node's index in generation 0 (baseline is index 0) — stable label
      const result = await mutateNode(shellNodes[0].prompt, state.config, rngFor(state.config.seed, 'fill', k + 1));
      
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
    persistRun(state);

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
      persistRun(state);
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
 * Main evaluation loop - Rolling queue implementation for maximum parallelism
 */
async function evaluationLoop(runId: UUID): Promise<void> {
  const state = activeEvaluations.get(runId);
  if (!state) {
    console.log(`[Evaluator] Evaluation loop called but state not found for ${runId.slice(0, 8)}`);
    return;
  }
  
  console.log(`[Evaluator] Evaluation loop started for ${runId.slice(0, 8)}`);
  console.log(`[Evaluator] Queue length: ${state.queue.length}, InProgress: ${state.inProgress.size}`);
  
  // Track active node processing promises
  const activePromises = new Set<Promise<void>>();
  
  // Helper to start processing a node
  const startNodeProcessing = (node: CandidateNode): Promise<void> => {
    const promise = processNode(runId, node, state).then(() => {
      activePromises.delete(promise);
      // After a node completes, check if we should process more
      processNextNode();
    });
    activePromises.add(promise);
    return promise;
  };
  
  // Helper to process next node from queue if we have capacity
  const processNextNode = () => {
    // Check stopping conditions
    if (shouldStop(state)) {
      return;
    }
    
    // Check if we should pause or stop
    if (state.status !== 'running') {
      return;
    }
    
    // Check if we have capacity and nodes to process
    if (activePromises.size < state.config.parallelLimit && state.queue.length > 0) {
      const node = state.queue.shift();
      if (node) {
        console.log(`[Evaluator] Starting node ${node.id.slice(0, 8)} (active: ${activePromises.size + 1}/${state.config.parallelLimit}, queue: ${state.queue.length})`);
        startNodeProcessing(node);
        
        // Try to fill remaining capacity immediately
        if (activePromises.size < state.config.parallelLimit && state.queue.length > 0) {
          setImmediate(() => processNextNode());
        }
      }
    }
  };
  
  // Start initial batch up to parallelLimit
  const initialBatchSize = Math.min(state.config.parallelLimit, state.queue.length);
  console.log(`[Evaluator] Starting initial batch of ${initialBatchSize} nodes`);
  for (let i = 0; i < initialBatchSize; i++) {
    processNextNode();
  }
  
  // Wait for all active processing to complete
  while (activePromises.size > 0 || state.queue.length > 0) {
    if (state.status !== 'running') {
      console.log(`[Evaluator] Status changed to ${state.status}, stopping node initiation`);
      break;
    }
    
    // Wait a bit before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check if generation is complete
    const currentGen = state.run.generations[state.currentGeneration];
    const allFinished = currentGen.every(n => 
      n.status === 'finished' || n.status === 'failed' || n.status === 'skipped'
    );
    
    if (allFinished && state.queue.length === 0 && activePromises.size === 0) {
      console.log(`[Evaluator] Generation ${state.currentGeneration} complete`);
      
      // Check stopping conditions
      if (shouldStop(state)) {
        await finishEvaluation(runId, state);
        return;
      }
      
      // Check if we would exceed maxGenerations by creating the next one
      if (state.config.targets.maxGenerations) {
        if (state.currentGeneration + 1 >= state.config.targets.maxGenerations) {
          console.log(`[Evaluator] Reached max generations (${state.config.targets.maxGenerations})`);
          state.run.stopReason = 'target';
          await finishEvaluation(runId, state);
          return;
        }
      }
      
      // Move to next generation
      await moveToNextGeneration(runId, state);
      
      // Start processing nodes from the new generation
      const newInitialBatchSize = Math.min(state.config.parallelLimit, state.queue.length);
      console.log(`[Evaluator] Starting ${newInitialBatchSize} nodes from new generation`);
      for (let i = 0; i < newInitialBatchSize; i++) {
        processNextNode();
      }
    }
  }
  
  console.log(`[Evaluator] Evaluation loop exited (status=${state.status}, queue=${state.queue.length}, inProgress=${state.inProgress.size})`);
  
  // If we exited because of pause, wait for any remaining in-progress nodes
  if (state.status === 'pausing') {
    console.log(`[Evaluator] Pausing... waiting for ${activePromises.size} active promises and ${state.inProgress.size} in-progress nodes to complete`);
    
    // Wait for all active promises to complete
    if (activePromises.size > 0) {
      await Promise.all(Array.from(activePromises));
    }
    
    // Double-check inProgress set
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
    persistRun(state);
  } else if (state.status === 'running') {
    // Loop exited naturally (queue empty)
    await finishEvaluation(runId, state);
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
      // Any operator name (built-in or plugin) is trackable — create lazily
      const opKey = String(operatorType);
      if (!state.operatorEffectiveness[opKey]) {
        state.operatorEffectiveness[opKey] = { totalDelta: 0, count: 0 };
      }
      const bucket = state.operatorEffectiveness[opKey];
      const fitnessDelta = node.metrics.fitness - parentFitness;
      bucket.totalDelta += fitnessDelta;
      bucket.count++;
      const avgDelta = bucket.totalDelta / bucket.count;
      console.log(`[Evaluator] Operator effectiveness [${opKey}]: avgΔ=${avgDelta.toFixed(3)} (count=${bucket.count})`);
    }
  } catch (error) {
    console.error(`[Evaluator] Node ${node.id.slice(0, 8)} failed:`, error);
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);

    // Circuit breaker: if the run was stopped due to grading failures, halt everything
    if (state.status === 'stopped' && state.run.stopReason === 'error') {
      state.inProgress.delete(node.id);
      sendUpdate(runId, { type: 'node_updated', node });
      sendUpdate(runId, { type: 'error', message: node.error });
      await finishEvaluation(runId, state);
      return;
    }
  }

  state.inProgress.delete(node.id);

  // Only send update if we didn't already send it in recalculateAllFitness
  if (!skipFinalUpdate) {
    sendUpdate(runId, { type: 'node_updated', node });
  }

  persistRun(state);
}

/**
 * Run all tests for a node
 */
async function runTests(
  runId: UUID,
  node: CandidateNode,
  state: EvaluationState
): Promise<TestResult[]> {
  // Generate cache key: hash(prompt, model, temperature, harness, fitness-test signature)
  const cacheKey = computeCacheKey(node, state);

  // Check cache
  if (state.cache.has(cacheKey)) {
    console.log(`[Evaluator] Cache hit for node ${node.id.slice(0, 8)}`);
    state.run.cacheHits++;
    sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    return state.cache.get(cacheKey)!;
  }

  const results = await evaluatePromptOnTests(node.prompt, node.params, state.fitnessTests, state, runId);

  // Store in cache
  state.cache.set(cacheKey, results);
  console.log(`[Evaluator] Cached results for node ${node.id.slice(0, 8)}`);
  return results;
}

/**
 * Evaluate an arbitrary prompt against a set of tests using the run's
 * harness settings (promptMode, samplesPerTest). Used for normal candidate
 * evaluation (fitness tests) and for the final holdout evaluation.
 * Costs accrue to state.run.totals and emit `totals` events.
 */
export async function evaluatePromptOnTests(
  candidatePrompt: string,
  params: CandidateParams,
  tests: TestCase[],
  state: EvaluationState,
  runId: UUID,
): Promise<TestResult[]> {
  const adapter = getProviderAdapter(params.model.provider);
  const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;

  return Promise.all(tests.map(async (test) => {
    const samples = await Promise.all(
      Array.from({ length: state.samplesPerTest }, (_v, i) =>
        runSingleSample(test, candidatePrompt, params, i, state, runId, adapter, maxTokens)),
    );

    const mean = samples.reduce((a, s) => a + s.score, 0) / samples.length;
    let passed: boolean;
    if (test.mode === 'exact_match' && test.grading?.strictZeroOnDeviation) {
      passed = samples.filter(s => s.exact).length * 2 > samples.length; // strict majority
    } else {
      passed = mean >= 7;
    }

    const testResult: TestResult = {
      testId: test.id,
      passed,
      score: mean,
      promptTokens: samples.reduce((a, s) => a + s.promptTokens, 0),
      completionTokens: samples.reduce((a, s) => a + s.completionTokens, 0),
      latencyMs: samples.reduce((a, s) => a + s.latencyMs, 0) / samples.length,
      outputText: samples[0].output,
      llmGradeReasoning: samples[0].reasoning,
      ...(state.samplesPerTest > 1 ? { samples: samples.map(s => s.score) } : {}),
    };
    return testResult;
  }));
}

async function runSingleSample(
  test: TestCase,
  candidatePrompt: string,
  params: CandidateParams,
  sampleIndex: number,
  state: EvaluationState,
  runId: UUID,
  adapter: ProviderAdapter,
  maxTokens: number,
): Promise<{ score: number; exact: boolean; passed: boolean; output: string; reasoning?: string;
             promptTokens: number; completionTokens: number; latencyMs: number }> {
    const system = state.promptMode === 'system' ? candidatePrompt : undefined;
    const samplePrompt = state.promptMode === 'system' ? test.prompt : `${candidatePrompt}\n\n${test.prompt}`;
    const sampleSeed = params.seed !== undefined ? params.seed + sampleIndex : undefined;

    // Load image if test has one
    let images: Array<{ base64: string; mimeType: string }> | undefined;
    if (test.image) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const imgBuf = fs.readFileSync(test.image);
        const ext = path.extname(test.image).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        images = [{ base64: imgBuf.toString('base64'), mimeType }];
      } catch (imgErr) {
        console.error(`[Evaluator] Failed to load image for test "${test.name}":`, imgErr);
      }
    }

    const result = await adapter.call({
      model: params.model.model,
      prompt: samplePrompt,
      system,
      temperature: params.temperature,
      seed: sampleSeed,
      maxTokens,
      providerOptions: state.config.providerOptions,
      images,
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
        candidatePrompt,
        test.prompt,
        result.output,
        state.config.serviceModel,
        serviceAdapter,
        maxTokens
      );
      
      score = gradingResult.score;
      passed = gradingResult.passed;
      llmGradeReasoning = gradingResult.reasoning;

      // Track grading parse failures for circuit breaker
      state.gradingTotal++;
      if ((gradingResult as any)._parseError) {
        state.gradingFailures++;
        const failRate = state.gradingFailures / state.gradingTotal;
        const MIN_SAMPLES = 20; // Don't trigger on small sample sizes
        if (state.gradingTotal >= MIN_SAMPLES && failRate > 0.08) {
          const pct = (failRate * 100).toFixed(1);
          const msg = `Run aborted: ${pct}% of grading calls failed to parse (${state.gradingFailures}/${state.gradingTotal}). The service model is producing malformed JSON. Try a different service model or adjust serviceModelMaxTokens.`;
          console.error(`[Evaluator] CIRCUIT BREAKER: ${msg}`);
          state.run.stopReason = 'error';
          state.status = 'stopped';
          throw new Error(msg);
        }
      }

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
          const { levenshteinScore0to10 } = await import('../utils/distance.js');
          score = levenshteinScore0to10(test.expected, result.output);
          passed = score >= 7; // 70% threshold
        } else if (distanceMetric === 'json_diff') {
          const { jsonDiffScore0to10 } = await import('../utils/distance.js');
          score = jsonDiffScore0to10(test.expected, result.output);
          passed = score >= 7;
        } else if (distanceMetric === 'numeric_abs') {
          const { numericAbsScore0to10 } = await import('../utils/distance.js');
          score = numericAbsScore0to10(test.expected, result.output);
          passed = score >= 7;
        } else {
          console.warn(`[Test] Unknown distance metric: ${distanceMetric}`);
          score = 5.0;
          passed = false;
        }
      }
    }
    
    const exact = test.mode === 'exact_match' && !!test.expected && result.output.trim() === test.expected.trim();

    return {
      score,
      exact,
      passed,
      output: result.output,
      reasoning: llmGradeReasoning,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    };
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
 * Pairwise playoff for the CURRENT generation (if enabled and not yet run).
 * Re-ranks the top contenders by head-to-head judging of their stored outputs;
 * ranks land on metrics.playoffRank and sharpen selection/elite/champion.
 * Judge calls are evaluation costs: accrued to run totals immediately and
 * counted against the budget (mid-playoff trip abandons remaining matches).
 */
async function maybeRunPlayoff(runId: UUID, state: EvaluationState): Promise<void> {
  if (!state.pairwiseEnabled) return;
  const genIndex = state.currentGeneration;
  if (state.run.playoffs?.some(p => p.generation === genIndex)) return;
  const llmTests = state.fitnessTests.filter(t => t.mode === 'llm_grade');
  if (llmTests.length === 0) return;

  const gen = state.run.generations[genIndex] || [];
  const finished = gen
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!);
  const contenders = finished.slice(0, state.pairwiseContenders);
  if (contenders.length < 2) return;

  const budget = state.config.targets.budgetUSD;
  if (budget && state.run.totals.usd >= budget) {
    console.warn('[Playoff] Budget exhausted — skipping playoff');
    return;
  }

  const { runPairwisePlayoff } = await import('./pairwise.js');
  const result = await runPairwisePlayoff({
    contenders,
    tests: llmTests,
    config: state.config,
    accrue: (usd, promptTokens, completionTokens) => {
      state.run.totals.usd += usd;
      state.run.totals.tokensPrompt += promptTokens;
      state.run.totals.tokensCompletion += completionTokens;
      state.run.totals.calls++;
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    },
    shouldAbort: () => !!(budget && state.run.totals.usd >= budget),
  });
  if (!result) return;

  result.ranking.forEach((id, i) => {
    const node = contenders.find(n => n.id === id);
    if (node?.metrics) {
      node.metrics.playoffRank = i + 1;
      sendUpdate(runId, { type: 'node_updated', node });
    }
  });
  state.run.playoffs = [...(state.run.playoffs ?? []), { generation: genIndex, ranking: result.ranking }];
  sendUpdate(runId, { type: 'playoff_result', generation: genIndex, ranking: result.ranking, matches: result.matches });
  persistRun(state);
  console.log(`[Playoff] Gen ${genIndex}: winner ${result.ranking[0].slice(0, 8)} (${result.matches} judge calls, ${result.ranking.length} contenders)`);
}

/**
 * Move to next generation: selection + variation
 */
async function moveToNextGeneration(
  runId: UUID,
  state: EvaluationState
): Promise<void> {
  console.log(`[Evaluator] Moving to generation ${state.currentGeneration + 1}`);
  
  // Playoff (if enabled) re-ranks the top contenders before selection
  await maybeRunPlayoff(runId, state);

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

  persistRun(state);

  console.log(`[Evaluator] Generation ${state.currentGeneration} created with ${newGenNodes.length} nodes`);
}

/**
 * Finish evaluation
 */
async function runHoldoutEvaluation(runId: UUID, state: EvaluationState): Promise<void> {
  if (state.holdoutTests.length === 0) return;

  const holdout: NonNullable<EvaluationRun['holdout']> = {
    testIds: state.holdoutTests.map(t => t.id),
    samplesPerTest: state.samplesPerTest,
  };
  state.run.holdout = holdout;

  // Champion = latest playoff winner when playoffs ran, else best finished node by fitness
  const finished = state.run.generations.flat().filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined);
  const playoffChampionId = [...(state.run.playoffs ?? [])]
    .sort((a, b) => b.generation - a.generation)[0]?.ranking[0];
  const champion =
    (playoffChampionId ? finished.find(n => n.id === playoffChampionId) : undefined)
    ?? [...finished].sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!)[0];
  if (!champion) {
    holdout.skipped = 'no-champion';
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }
  if (state.config.targets.budgetUSD && state.run.totals.usd >= state.config.targets.budgetUSD) {
    holdout.skipped = 'budget';
    console.warn('[Evaluator] Budget exhausted — skipping holdout evaluation');
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }

  console.log(`[Evaluator] Holdout: evaluating seed + champion on ${state.holdoutTests.length} unseen test(s)`);
  const meanScore = (rs: TestResult[]) => rs.reduce((a, r) => a + r.score, 0) / rs.length;
  const perTest = (rs: TestResult[]) => rs.map(r => ({ testId: r.testId, score: r.score }));

  try {
    const championResults = await evaluatePromptOnTests(champion.prompt, champion.params, state.holdoutTests, state, runId);
    holdout.champion = { score: meanScore(championResults), perTest: perTest(championResults) };
    const seedResults = await evaluatePromptOnTests(state.config.population.seedPrompt, champion.params, state.holdoutTests, state, runId);
    holdout.seed = { score: meanScore(seedResults), perTest: perTest(seedResults) };
    console.log(`[Evaluator] Generalization (unseen tests): seed ${holdout.seed.score.toFixed(2)} → champion ${holdout.champion.score.toFixed(2)}`);
  } catch (error) {
    console.error('[Evaluator] Holdout evaluation failed:', error);
  }
  sendUpdate(runId, { type: 'holdout_result', holdout });
  persistRun(state);
}

async function finishEvaluation(runId: UUID, state: EvaluationState): Promise<void> {
  // The final generation never reaches moveToNextGeneration — run its playoff here
  // so the champion (and the holdout below) reflect the last generation's ranking.
  await maybeRunPlayoff(runId, state);
  await runHoldoutEvaluation(runId, state);
  console.log(`[Evaluator] Finishing evaluation, reason=${state.run.stopReason}`);
  
  state.status = 'stopped';
  state.run.status = 'finished';
  state.run.finishedAt = Date.now();

  persistRun(state);

  // Send final updates
  if (state.run.stopReason) {
    sendUpdate(runId, { type: 'stop', reason: state.run.stopReason });
  }
  sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
  sendUpdate(runId, { type: 'status', status: 'finished' });
  
  // Remove from active evaluations
  activeEvaluations.delete(runId);
  
  console.log(`[Evaluator] Evaluation ${runId.slice(0, 8)} finished`);
}

/** Cache key: hash(prompt, model, temperature, harness, fitness-test signature). */
function computeCacheKey(node: CandidateNode, state: EvaluationState): string {
  const testSetSig = state.fitnessTests.map(t => t.id).join(',');
  return createHash('sha256')
    .update(`${node.prompt}|${node.params.model.provider}/${node.params.model.model}|${node.params.temperature}|${state.promptMode}|${state.samplesPerTest}|${testSetSig}`)
    .digest('hex');
}

/** Checkpoint the run so an interrupted process loses nothing. Never throws. */
function persistRun(state: EvaluationState): void {
  try {
    const db = getDatabase();
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?
      WHERE id = ?
    `).run(JSON.stringify(state.run), state.run.id);
  } catch (error) {
    console.error('[Evaluator] Checkpoint persist failed:', error);
  }
}

/** True while a run is registered in this process (running/pausing/paused). */
export function isEvaluationActive(runId: UUID): boolean {
  return activeEvaluations.has(runId);
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
    // stopEvaluation is a sync host API — fire and forget the async finish
    finishEvaluation(runId, state).catch(err => console.error('[Evaluator] finish failed:', err));
  }
}

