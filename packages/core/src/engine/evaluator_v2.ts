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
  ModelRef,
} from '../types.js';
import { createHash } from 'crypto';
import { createShellPopulation, mutateNode } from './operators_v2.js';
import { selectTopPerformers, createNextGeneration } from './generation.js';
import { getProviderAdapter } from '../providers/index.js';
import { initGlobalSemaphore } from './semaphore.js';
import { rngFor } from './rng.js';
import { COST_LABELS } from './estimate.js';
import { selectChampion } from './champion.js';
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
  costContext: 'evolution' | 'holdout'; // routes accruals to holdout labels during the final evaluation
  finishing: boolean;         // idempotency latch: finishEvaluation must run exactly once
  loopRunning: boolean;       // re-entrancy guard: exactly one evaluationLoop per state
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
    // Math.max(...[]) is -Infinity: every node costing $0 (uncatalogued model)
    // would otherwise hand fitness a negative normalizer. Leave it undefined so
    // the configured absolute cap is used instead.
    const costs = finishedNodes.map(n => n.metrics?.costUSD || 0).filter(c => c > 0);
    maxCost = costs.length > 0 ? Math.max(...costs) : undefined;
    console.log(`[Fitness Recalc] Dynamic max cost: ${maxCost === undefined ? 'n/a (all $0)' : '$' + maxCost.toFixed(6)} (from ${finishedNodes.length} nodes)`);
  }

  if (state.config.fitness.latencyNorm?.mode === 'relative' && (state.config.fitness.weights.latency || 0) > 0) {
    const latencies = finishedNodes.map(n => n.metrics?.latencyMs || 0).filter(l => l > 0);
    maxLatency = latencies.length > 0 ? Math.max(...latencies) : undefined;
    console.log(`[Fitness Recalc] Dynamic max latency: ${maxLatency === undefined ? 'n/a' : maxLatency.toFixed(1) + 'ms'} (from ${finishedNodes.length} nodes)`);
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

  // A loaded run with generations is a checkpoint — resume it instead of starting fresh
  const isResume = run.generations.length > 0;
  if (isResume && run.status === 'finished') {
    throw new Error(`Run ${runId} is already finished`);
  }
  
  // Resolve the parallel limit ONCE and write it back onto the config: the
  // loop compares against it directly, and a 0/undefined/NaN value there means
  // no node is ever started and the run spins forever.
  const globalLimit = Math.max(1, Math.floor(config.parallelLimit || 5));
  if (globalLimit !== config.parallelLimit) {
    console.warn(`[Evaluator] parallelLimit ${config.parallelLimit} resolved to ${globalLimit}`);
    config.parallelLimit = globalLimit;
  }
  initGlobalSemaphore(globalLimit);
  console.log(`[Evaluator] Global API limit: ${globalLimit}`);

  // Budget enforcement is computed from catalogued prices, so an uncatalogued
  // model counts every call as $0 and the cap can never trip. That is CORRECT
  // for a genuinely free local model and WRONG for a missing catalog entry, and
  // the engine cannot tell them apart — so record it on the run and warn loudly
  // rather than guessing.
  {
    const { getModelCost } = await import('../providers/costs.js');
    const unpriced: string[] = [];
    for (const model of [...config.enabledModels, config.serviceModel]) {
      const key = `${model.provider}/${model.model}`;
      if (unpriced.includes(key)) continue;
      const entry = await getModelCost(model);
      if (!entry || (entry.promptUSDper1k === 0 && entry.completionUSDper1k === 0)) {
        unpriced.push(key);
      }
    }
    if (unpriced.length > 0) {
      run.pricingUnknown = unpriced;
      console.warn(
        `[Evaluator] No catalogued pricing for ${unpriced.join(', ')} — those calls count as $0. ` +
        (config.targets.budgetUSD !== undefined
          ? `budgetUSD ($${config.targets.budgetUSD}) CANNOT be enforced against them. `
          : '') +
        `Run --list-models / --sync-models if this is unexpected.`
      );
    }
  }

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
      generations: isResume ? run.generations : [[]],
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
    costContext: 'evolution',
    finishing: false,
    loopRunning: false,
    // Restore accumulated paused time: hard-zeroing it on resume charges every
    // second the process was DEAD against targets.timeLimitMs.
    //
    // Restoring it is not enough on its own — the interval between the crash
    // and the resume was never recorded anywhere, so timeLimitMs measured from
    // the ORIGINAL startedAt and a run resumed the next morning stopped
    // instantly with stopReason 'time' having done zero work. Credit that gap
    // as paused time; `finishedAt ?? lastCheckpointAt` is the best evidence we
    // have of when the process actually stopped.
    totalPausedMs: (run.totalPausedMs ?? 0) + (isResume ? downtimeSinceCheckpoint(run) : 0),
    gradingTotal: 0,
    gradingFailures: 0,
  };

  activeEvaluations.set(runId, state);

  // Send running status
  sendUpdate(runId, { type: 'status', status: 'running' });
  console.log(`[Evaluator] Status sent: running`);

  if (isResume) {
    state.currentGeneration = state.run.generations.length - 1;
    state.run.stopReason = undefined;
    const TERMINAL = new Set(['finished', 'failed', 'skipped']);
    let kept = 0, requeued = 0, refill = 0;
    for (const gen of state.run.generations) {
      for (const node of gen) {
        if (TERMINAL.has(node.status)) {
          if (node.status === 'finished' && node.tests?.length) {
            state.cache.set(computeCacheKey(node, state), node.tests);
          }
          kept++;
        } else if (node.generation === 0 && node.changeLog?.[0]?.text === 'Waiting for mutation...') {
          node.status = 'pending';
          node.tests = undefined; node.metrics = undefined; node.error = undefined;
          refill++;
        } else {
          node.status = 'awaiting';
          node.tests = undefined; node.metrics = undefined; node.error = undefined;
          requeued++;
        }
      }
    }
    console.log(`[Evaluator] Resuming from generation ${state.currentGeneration}: ${kept} kept, ${requeued} re-queued, ${refill} pending fill, $${state.run.totals.usd.toFixed(4)} already spent`);

    // Replay existing state to the host (rebuilds CLI collector / desktop UI)
    for (const gen of state.run.generations) {
      for (const node of gen) sendUpdate(runId, { type: 'node_created', node });
    }
    sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });

    if (state.run.generations[0].some(n => n.status === 'pending')) {
      // Interrupted during initial fill — the fill path re-mutates pending nodes,
      // then queues gen 0 and starts the loop
      mutatePopulationInBackground(runId, state);
    } else {
      state.queue = state.run.generations[state.currentGeneration].filter(n => n.status === 'awaiting');
      console.log(`[Evaluator] Resume queue: ${state.queue.length} nodes`);
      startEvaluationLoop(runId);
    }
    console.log(`[Evaluator] startEvaluation returning (resume)`);
    return;
  }

  // Create shell population (synchronous, fast).
  // If this throws (missing seed prompt, malformed manual population) the state
  // must be unregistered — otherwise the run id looks permanently "active":
  // isEvaluationActive stays true and every retry fails with
  // "Evaluation already running" until the process restarts.
  let shellNodes: CandidateNode[];
  try {
    console.log(`[Evaluator] Creating shell population...`);
    shellNodes = createShellPopulation(config);
  } catch (error) {
    activeEvaluations.delete(runId);
    throw error;
  }
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
      startEvaluationLoop(runId);
    }
    return;
  }
  
  // Status-based (not index-based): fresh shell nodes 1..N-1 are 'pending'; on
  // resume only the nodes whose fill never completed are still 'pending'.
  const nodesToMutate = shellNodes.filter(n => n.status === 'pending');

  console.log(`[Evaluator] Mutating ${nodesToMutate.length} nodes in parallel...`);

  const fillNode = async (node: CandidateNode) => {
    try {
      // The fill phase runs before the evaluation loop's first budget check —
      // without this gate, 2×(initialSize-1) service calls always execute in
      // full no matter how small the budget is.
      if (budgetExhausted(state)) {
        console.warn(`[Evaluator] Budget exhausted before filling node ${node.id.slice(0, 8)} — carrying the seed prompt forward`);
        node.status = 'awaiting';
        node.changeLog = [{ label: 'CARRY', text: 'Budget exhausted before mutation' }];
        sendUpdate(runId, { type: 'node_updated', node });
        return;
      }

      console.log(`[Evaluator] Mutating node ${node.id.slice(0, 8)}...`);

      // Stable label: the node's index in generation 0 — identical streams across resume
      const gen0Index = shellNodes.indexOf(node);
      const result = await mutateNode(shellNodes[0].prompt, state.config, rngFor(state.config.seed, 'fill', gen0Index));
      
      // Update node
      node.prompt = result.prompt;
      node.changeLog = result.changeLog;
      node.status = 'awaiting';
      
      // Track costs
      accrueCost(state, COST_LABELS.fill, state.config.serviceModel, {
        usd: result.cost.usd, promptTokens: result.cost.promptTokens,
        completionTokens: result.cost.completionTokens, calls: result.cost.calls,
      });
      
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
      
      // Calls made before the failure were still billed — account for them
      const { partialCostOf } = await import('./operator-cost.js');
      const spent = partialCostOf(error);
      if (spent.calls > 0) {
        console.warn(`[Evaluator] Failed mutation still spent $${spent.usd.toFixed(6)} over ${spent.calls} call(s) — accounting for it`);
        accrueCost(state, COST_LABELS.fill, state.config.serviceModel, spent);
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      }

      // Mark as failed
      node.status = 'failed';
      node.error = `Mutation failed: ${error instanceof Error ? error.message : String(error)}`;
      
      // Send error update
      sendUpdate(runId, { type: 'node_updated', node });
    }
  };

  // Bounded worker pool, NOT nodesToMutate.map(...). A plain .map drives every
  // async body to its first await in one tick, so all N budget checks read
  // totals.usd === 0 and the gate never fires — an initialSize of 20 against a
  // two-call budget still spent 38 calls. Workers pull one node at a time, so
  // each check sees the spend of everything that finished before it.
  const workerCount = Math.max(1, Math.min(state.config.parallelLimit || 1, nodesToMutate.length));
  let nextNodeIndex = 0;
  const mutationPromises = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextNodeIndex++;
      if (index >= nodesToMutate.length) return;
      await fillNode(nodesToMutate[index]);
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
      startEvaluationLoop(runId);
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
/**
 * Fire-and-forget entry point for the loop.
 *
 * Every caller starts the loop without awaiting it, so anything that escaped
 * evaluationLoop became an unhandled rejection — which on Node 15+ terminates
 * the process. A single misbehaving operator plugin could therefore kill the
 * CLI outright, or (in Electron, where the renderer survives) leave the run
 * wedged at status 'running' forever with no error ever shown.
 */
function startEvaluationLoop(runId: UUID): void {
  evaluationLoop(runId).catch(error => {
    console.error(`[Evaluator] Evaluation loop crashed for ${runId.slice(0, 8)}:`, error);
    const state = activeEvaluations.get(runId);
    if (state) {
      state.loopRunning = false;
      // 'stopped' + stopReason 'error' is the closest terminal state the run
      // schema has; without it the run stays 'running' forever in the UI.
      state.status = 'stopped';
      state.run.status = 'stopped';
      state.run.stopReason = 'error';
      state.run.finishedAt = Date.now();
      try {
        persistRun(state);
      } catch (persistError) {
        console.error('[Evaluator] Could not persist the crashed run:', persistError);
      }
      activeEvaluations.delete(runId);
    }
    sendUpdate(runId, { type: 'error', message: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}` });
    sendUpdate(runId, { type: 'stop', reason: 'error' });
    sendUpdate(runId, { type: 'status', status: 'stopped' });
  });
}

async function evaluationLoop(runId: UUID): Promise<void> {
  const state = activeEvaluations.get(runId);
  if (!state) {
    console.log(`[Evaluator] Evaluation loop called but state not found for ${runId.slice(0, 8)}`);
    return;
  }

  // Re-entrancy guard: two loops over one state race the generation transition
  // (an in-creation generation is momentarily [], which reads as "complete") and
  // can finish the run with an empty final generation full of paid-for zombies.
  if (state.loopRunning) {
    console.warn(`[Evaluator] Evaluation loop already running for ${runId.slice(0, 8)} — ignoring duplicate start`);
    return;
  }
  state.loopRunning = true;

  console.log(`[Evaluator] Evaluation loop started for ${runId.slice(0, 8)}`);
  console.log(`[Evaluator] Queue length: ${state.queue.length}, InProgress: ${state.inProgress.size}`);
  
  // Track active node processing promises
  const activePromises = new Set<Promise<void>>();
  
  // Helper to start processing a node
  const startNodeProcessing = (node: CandidateNode): Promise<void> => {
    // .catch is load-bearing: an unhandled rejection here (e.g. the host's
    // sendUpdate throwing because the window was destroyed) would leave the
    // promise in activePromises forever, wedging the loop permanently.
    const promise = processNode(runId, node, state)
      .catch((error) => {
        console.error(`[Evaluator] processNode rejected for ${node.id.slice(0, 8)}:`, error);
        node.status = 'failed';
        node.error = error instanceof Error ? error.message : String(error);
        state.inProgress.delete(node.id);
      })
      .then(() => {
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
  
  // Wait for all active processing to complete. do..while (not while): a run
  // resumed from a checkpoint taken AT a generation boundary arrives here with
  // an empty queue and a fully terminal generation — the body must still run
  // once to perform the generation transition instead of finishing prematurely.
  do {
    if (state.status !== 'running') {
      console.log(`[Evaluator] Status changed to ${state.status}, stopping node initiation`);
      break;
    }

    // A tripped stop condition (e.g. resumed with restored spend already over
    // budget) blocks processNextNode from ever starting work — without this
    // exit the loop would spin forever on a non-empty queue.
    if (shouldStop(state) && activePromises.size === 0) {
      console.log(`[Evaluator] Stop condition tripped with ${state.queue.length} queued nodes — skipping them`);
      for (const queued of state.queue) queued.status = 'skipped';
      state.queue = [];
      state.loopRunning = false;
      await finishEvaluation(runId, state);
      return;
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
        state.loopRunning = false;
        await finishEvaluation(runId, state);
        return;
      }

      // Check if we would exceed maxGenerations by creating the next one
      if (state.config.targets.maxGenerations !== undefined) {
        if (state.currentGeneration + 1 >= state.config.targets.maxGenerations) {
          console.log(`[Evaluator] Reached max generations (${state.config.targets.maxGenerations})`);
          state.run.stopReason = 'generations';
          state.loopRunning = false;
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
  } while (activePromises.size > 0 || state.queue.length > 0);

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
    
    // A Resume that arrived DURING the drain was rejected by the re-entrancy
    // guard (loopRunning was still true), so simply returning here left no loop
    // running at all: the run sat at status 'running' forever, making no
    // progress, and a second Resume was refused because it was not 'paused'.
    // Hand the loop over explicitly instead.
    if (state.status !== 'pausing') {
      console.log(`[Evaluator] Resume arrived during the pause drain (status=${state.status}) — restarting the loop`);
      state.loopRunning = false;
      if (state.status === 'running') startEvaluationLoop(runId);
      return;
    }
    console.log(`[Evaluator] All in-progress nodes completed, now fully paused`);
    state.status = 'paused';
    state.run.status = 'paused';
    state.run.totalPausedMs = state.totalPausedMs; // Update run object
    state.pausedAt = Date.now(); // Record when actually paused
    state.run.pausedAt = state.pausedAt; // Send to frontend
    sendUpdate(runId, { type: 'status', status: 'paused', totalPausedMs: state.totalPausedMs, pausedAt: state.pausedAt });
    persistRun(state);
    // Cleared only now, AFTER the drain. Clearing it before let a Resume during
    // the drain start a second loop over the same state — the exact race the
    // guard exists to prevent.
    state.loopRunning = false;
  } else if (state.status === 'running') {
    state.loopRunning = false;
    // Loop exited naturally (queue empty)
    await finishEvaluation(runId, state);
  } else {
    state.loopRunning = false;
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
        maxTokens,
        state.config.callTimeoutMs
      );
      
      safetyScore = safetyResult.score;
      
      // Track service model costs from safety checks
      accrueCost(state, COST_LABELS.safety, state.config.serviceModel, {
        usd: safetyResult.totalCost, promptTokens: safetyResult.totalPromptTokens,
        completionTokens: safetyResult.totalCompletionTokens, calls: safetyResult.calls,
      });
      
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
      accrueCost(state, COST_LABELS.stability, node.params.model, {
        usd: stabilityResult.totalCost, promptTokens: stabilityResult.totalPromptTokens,
        completionTokens: stabilityResult.totalCompletionTokens, calls: stabilityResult.calls,
      });
      
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
    // Budget exhaustion is a controlled stop, not a node failure: mark the node
    // skipped so it isn't reported as a broken candidate, and let the loop's
    // shouldStop finish the run cleanly.
    if (error instanceof BudgetExhaustedError) {
      console.log(`[Evaluator] Node ${node.id.slice(0, 8)} abandoned: budget exhausted`);
      node.status = 'skipped';
      state.run.stopReason = 'budget';
      state.inProgress.delete(node.id);
      sendUpdate(runId, { type: 'node_updated', node });
      return;
    }

    console.error(`[Evaluator] Node ${node.id.slice(0, 8)} failed:`, error);
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);

    // Circuit breaker: if the run was stopped due to grading failures, halt everything
    if (state.status === 'stopped' && state.run.stopReason === 'error') {
      state.inProgress.delete(node.id);
      sendUpdate(runId, { type: 'node_updated', node });
      sendUpdate(runId, { type: 'error', message: node.error });
      state.loopRunning = false;
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

    // Budget gate at the actual spend point: node-boundary checks alone let a
    // single generation fire tests × samples × parallelLimit more calls after
    // the cap was reached.
    if (budgetExhausted(state)) {
      throw new BudgetExhaustedError();
    }

    const result = await adapter.call({
      model: params.model.model,
      prompt: samplePrompt,
      system,
      temperature: params.temperature,
      seed: sampleSeed,
      maxTokens,
      timeoutMs: state.config.callTimeoutMs,
      ...(test.mode === 'tool_call' && test.tools?.length ? { tools: test.tools } : {}),
      providerOptions: state.config.providerOptions,
      images,
    });

    // Tool responses serialize into the output channel so samples, cache,
    // playoff, reports, and the UI all compose without special cases.
    const effectiveOutput = result.toolCalls
      ? JSON.stringify({ toolCalls: result.toolCalls }, null, 2)
      : result.output;
    
    // Update totals immediately for candidate model call
    accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdout : COST_LABELS.candidates, params.model, {
      usd: result.usd, promptTokens: result.promptTokens,
      completionTokens: result.completionTokens, calls: 1,
    });
    
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
      // Grading is a second billable call per sample — gate it too
      if (budgetExhausted(state)) {
        throw new BudgetExhaustedError();
      }
      const { evaluateTestResultLLM } = await import('./fitness.js');
      const serviceAdapter = getProviderAdapter(state.config.serviceModel.provider);
      
      const gradingResult = await evaluateTestResultLLM(
        test,
        candidatePrompt,
        test.prompt,
        result.output,
        state.config.serviceModel,
        serviceAdapter,
        maxTokens,
        state.config.callTimeoutMs
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
      accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdoutGrading : COST_LABELS.grading, state.config.serviceModel, {
        usd: gradingResult.usd, promptTokens: gradingResult.promptTokens,
        completionTokens: gradingResult.completionTokens, calls: 1,
      });
      
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
    } else if (test.mode === 'json_schema') {
      const { scoreJsonSchema } = await import('./structured.js');
      const r = scoreJsonSchema(effectiveOutput, test.schema, test.id);
      score = r.score; passed = r.passed; llmGradeReasoning = r.detail;
    } else if (test.mode === 'tool_call') {
      const { scoreToolCall } = await import('./structured.js');
      const r = scoreToolCall(result.toolCalls, test.expectedTool);
      score = r.score; passed = r.passed; llmGradeReasoning = r.detail;
    }

    const exact = test.mode === 'exact_match' && !!test.expected && result.output.trim() === test.expected.trim();

    return {
      score,
      exact,
      passed,
      output: effectiveOutput,
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
  if (config.targets.timeLimitMs !== undefined) {
    const wallClockElapsed = Date.now() - run.startedAt;
    const activeElapsed = wallClockElapsed - state.totalPausedMs;
    if (activeElapsed >= config.targets.timeLimitMs) {
      console.log(`[Evaluator] Time limit reached: ${activeElapsed}ms active (${wallClockElapsed}ms total, ${state.totalPausedMs}ms paused)`);
      state.run.stopReason = 'time';
      return true;
    }
  }
  
  // Budget limit (!== undefined, not truthiness: budgetUSD 0 means "spend
  // nothing", not "no limit")
  if (config.targets.budgetUSD !== undefined) {
    if (run.totals.usd >= config.targets.budgetUSD) {
      state.run.stopReason = 'budget';
      return true;
    }
  }
  
  // Target fitness
  if (config.targets.targetFitness !== undefined) {
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
  if (config.targets.maxGenerations !== undefined) {
    if (state.currentGeneration >= config.targets.maxGenerations) {
      // 'generations', NOT 'target': running out of generations is the ordinary
      // end of every run, while 'target' means the quality bar was actually
      // reached. Reporting both as 'target' made any script branching on
      // stopReason === 'target' wrong on essentially every run.
      state.run.stopReason = 'generations';
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

  // !== undefined, not truthiness: budgetUSD 0 means "spend nothing", and
  // truthiness read it as "no limit" — so a 0-budget resume could still fund a
  // full round of judge calls.
  const budget = state.config.targets.budgetUSD;
  const budgetCapped = budget !== undefined;
  if (budgetCapped && state.run.totals.usd >= budget!) {
    console.warn('[Playoff] Budget exhausted — skipping playoff');
    return;
  }

  const { runPairwisePlayoff } = await import('./pairwise.js');
  const result = await runPairwisePlayoff({
    contenders,
    tests: llmTests,
    config: state.config,
    accrue: (usd, promptTokens, completionTokens) => {
      accrueCost(state, COST_LABELS.playoff, state.config.serviceModel, { usd, promptTokens, completionTokens, calls: 1 });
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    },
    shouldAbort: () => budgetCapped && state.run.totals.usd >= budget!,
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
  accrueCost(state, COST_LABELS.operators, state.config.serviceModel, {
    usd: result.costTracking.usd, promptTokens: result.costTracking.promptTokens,
    completionTokens: result.costTracking.completionTokens, calls: result.costTracking.calls,
  });
  
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

  const finished = state.run.generations.flat().filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined);
  const { champion, staleplayoffIgnored } = selectChampion(finished, state.run.playoffs, n => n.generation);
  if (staleplayoffIgnored) {
    console.warn('[Evaluator] Last playoff predates the newest evaluated generation — ranking the champion by fitness instead');
  }
  if (!champion) {
    holdout.skipped = 'no-champion';
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }
  // Same 0-means-zero rule as the playoff gate above.
  if (state.config.targets.budgetUSD !== undefined && state.run.totals.usd >= state.config.targets.budgetUSD) {
    holdout.skipped = 'budget';
    console.warn('[Evaluator] Budget exhausted — skipping holdout evaluation');
    sendUpdate(runId, { type: 'holdout_result', holdout });
    return;
  }

  console.log(`[Evaluator] Holdout: evaluating seed + champion on ${state.holdoutTests.length} unseen test(s)`);
  const meanScore = (rs: TestResult[]) => rs.reduce((a, r) => a + r.score, 0) / rs.length;
  const perTest = (rs: TestResult[]) => rs.map(r => ({ testId: r.testId, score: r.score }));

  state.costContext = 'holdout';
  try {
    const championResults = await evaluatePromptOnTests(champion.prompt, champion.params, state.holdoutTests, state, runId);
    holdout.champion = { score: meanScore(championResults), perTest: perTest(championResults) };
    const seedResults = await evaluatePromptOnTests(state.config.population.seedPrompt, champion.params, state.holdoutTests, state, runId);
    holdout.seed = { score: meanScore(seedResults), perTest: perTest(seedResults) };
    console.log(`[Evaluator] Generalization (unseen tests): seed ${holdout.seed.score.toFixed(2)} → champion ${holdout.champion.score.toFixed(2)}`);
  } catch (error) {
    console.error('[Evaluator] Holdout evaluation failed:', error);
  } finally {
    state.costContext = 'evolution';
  }
  sendUpdate(runId, { type: 'holdout_result', holdout });
  persistRun(state);
}

async function finishEvaluation(runId: UUID, state: EvaluationState): Promise<void> {
  // Idempotency latch: the circuit-breaker path can invoke this from several
  // failing nodes concurrently — playoff/holdout spend must not run twice.
  if (state.finishing) return;
  state.finishing = true;

  // Drain in-flight nodes first (manual stop leaves them running): their
  // accruals must land under evolution labels BEFORE costContext flips to
  // holdout, and the final persisted run must include their results.
  // Bounded: every call now carries an abort timeout.
  while (state.inProgress.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // The final generation never reaches moveToNextGeneration — run its playoff here
  // so the champion (and the holdout below) reflect the last generation's ranking.
  // Both are billable: a user who pressed Stop wants spending to STOP, not to
  // fund a playoff plus a holdout pass afterwards.
  if (state.run.stopReason === 'manual') {
    console.log('[Evaluator] Manual stop — skipping playoff and holdout to stop spending');
  } else {
    await maybeRunPlayoff(runId, state);
    await runHoldoutEvaluation(runId, state);
  }
  console.log(`[Evaluator] Finishing evaluation, reason=${state.run.stopReason}`);
  
  state.status = 'stopped';
  state.run.status = 'finished';
  state.run.finishedAt = Date.now();

  persistRun(state);

  sendUpdate(runId, { type: 'cost_breakdown', breakdown: state.run.costBreakdown, estimate: state.run.estimate });

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

/**
 * Cache key: hash(prompt, model, temperature, harness, fitness-test signature).
 * params.seed is deliberately NOT part of the key: children inherit their
 * parent's seed under the current policy, so key components co-vary. If seeds
 * ever become per-child, add seed here or the cache will serve cross-seed hits.
 */
function computeCacheKey(node: CandidateNode, state: EvaluationState): string {
  const testSetSig = state.fitnessTests.map(t => t.id).join(',');
  return createHash('sha256')
    .update(`${node.prompt}|${node.params.model.provider}/${node.params.model.model}|${node.params.temperature}|${state.promptMode}|${state.samplesPerTest}|${testSetSig}`)
    .digest('hex');
}

/**
 * True when the run has already spent its budget. Checked immediately before
 * every billable call — `shouldStop` alone is only consulted at node
 * boundaries, so a node with N tests × M samples could fire N×M×2 more calls
 * (times parallelLimit) after the cap was already reached.
 */
function budgetExhausted(state: EvaluationState): boolean {
  const budget = state.config.targets.budgetUSD;
  return budget !== undefined && state.run.totals.usd >= budget;
}

/** Thrown to abandon in-flight work the moment the budget is gone. */
class BudgetExhaustedError extends Error {
  constructor() {
    super('Budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

/** Single accounting path: totals + per-purpose + per-model breakdown together. */
function accrueCost(
  state: EvaluationState,
  purpose: string,
  model: ModelRef,
  c: { usd: number; promptTokens: number; completionTokens: number; calls: number },
): void {
  state.run.totals.usd += c.usd;
  state.run.totals.tokensPrompt += c.promptTokens;
  state.run.totals.tokensCompletion += c.completionTokens;
  state.run.totals.calls += c.calls;
  const bd = (state.run.costBreakdown ??= {});
  for (const key of [purpose, `model:${model.provider}/${model.model}`]) {
    const rec = (bd[key] ??= { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 });
    rec.calls += c.calls;
    rec.promptTokens += c.promptTokens;
    rec.completionTokens += c.completionTokens;
    rec.usd += c.usd;
  }
}

/** Checkpoint the run so an interrupted process loses nothing. Never throws. */
/**
 * How long this run was NOT running, measured from its last checkpoint.
 *
 * timeLimitMs is measured from run.startedAt minus paused time, and the gap
 * between a crash and a --resume was recorded nowhere — so a run resumed the
 * next morning stopped instantly with stopReason 'time' having done no work.
 * Runs checkpointed before lastCheckpointAt existed fall back to startedAt,
 * which credits the whole elapsed span: over-generous, but it errs toward
 * letting the user's resumed run proceed rather than killing it on arrival.
 */
function downtimeSinceCheckpoint(run: EvaluationRun): number {
  const lastAlive = run.lastCheckpointAt ?? run.startedAt;
  return Math.max(0, Date.now() - lastAlive);
}

function persistRun(state: EvaluationState): void {
  try {
    state.run.lastCheckpointAt = Date.now();
    const db = getDatabase();
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?
      WHERE id = ?
    `).run(JSON.stringify(state.run), state.run.id);
    // Flush now instead of 50ms from now. docs/cli.md promises "if the process
    // dies, nothing is lost" — with only the debounced save, a hard crash
    // inside that window lost the checkpoint the resume path depends on.
    // Checkpoints happen once per generation, so the extra fsync is cheap.
    db.flush();
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
    // Only a paused run can resume. Without this, a double-click in the desktop
    // fires two resumes and starts a second evaluation loop over shared state.
    if (state.status !== 'paused' && state.status !== 'pausing') {
      console.warn(`[Evaluator] Resume ignored for ${runId.slice(0, 8)}: status is '${state.status}', not paused`);
      return;
    }
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
    
    // An empty queue does NOT mean there is nothing to do. At every generation
    // boundary — and immediately whenever parallelLimit >= generationSize —
    // queue and inProgress are both 0 while the generation transition is still
    // pending, so refusing to start the loop left the run stuck at 'paused'
    // forever with no way to make progress.
    //
    // The one case where the loop must NOT start is the initial fill: gen 0
    // nodes are still 'pending' mutation, the loop would find no work, exit,
    // and prematurely finish the run. mutatePopulationInBackground starts the
    // loop itself when it is done.
    const fillInFlight = (state.run.generations[state.currentGeneration] ?? [])
      .some(n => n.status === 'pending');
    if (state.queue.length > 0 || state.inProgress.size > 0 || !fillInFlight) {
      console.log(`[Evaluator] Starting evaluation loop on resume`);
      startEvaluationLoop(runId);
    } else {
      console.log(`[Evaluator] Population fill still in progress — it will start the loop when done`);
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

