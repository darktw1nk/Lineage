import type {
  EvaluationConfig,
  EvaluationRun,
  CandidateNode,
  TestCase,
  TestResult,
  UUID,
} from '../../src/types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { getProviderAdapter } from '../providers/index.js';
import { calculateFitness, evaluateTestResult } from './fitness.js';
import {
  applyMutation,
  applyCrossover,
  applyMetaPrompting,
  applyParameterVariation,
  generateInitialPopulation,
} from './operators.js';
import { initGlobalSemaphore } from './semaphore.js';
import { BrowserWindow } from 'electron';
import crypto from 'crypto';

interface OperatorEffectiveness {
  mutation: { totalDelta: number; count: number };
  crossover: { totalDelta: number; count: number };
  meta: { totalDelta: number; count: number };
  param: { totalDelta: number; count: number };
}

interface EvaluationState {
  run: EvaluationRun;
  config: EvaluationConfig;
  status: 'running' | 'paused' | 'stopped';
  currentGeneration: number;
  queue: CandidateNode[];
  inProgress: Set<UUID>;
  cache: Map<string, TestResult[]>;
  lineageHistory: Map<UUID, { bestFitness: number; stagnantGenerations: number }>;
  operatorEffectiveness: OperatorEffectiveness;
}

// Helper to track service model costs
function trackServiceCost(state: EvaluationState, usd: number, tokens: { prompt: number; completion: number }): void {
  state.run.totals.usd += usd;
  state.run.totals.tokensPrompt += tokens.prompt;
  state.run.totals.tokensCompletion += tokens.completion;
  state.run.totals.calls++;
}

const activeEvaluations = new Map<UUID, EvaluationState>();

export async function startEvaluation(
  runId: UUID,
  config: EvaluationConfig,
  run: EvaluationRun
): Promise<void> {
  if (activeEvaluations.has(runId)) {
    throw new Error('Evaluation already running');
  }
  
  // Initialize global semaphore with parallelLimit from config
  // This limits ALL API calls (service model + candidate models) to this limit
  const globalLimit = config.parallelLimit || 5;
  console.log(`[Evaluation] Initializing global API call limit: ${globalLimit}`);
  initGlobalSemaphore(globalLimit);
  
  // Create state FIRST (before generating population)
  const state: EvaluationState = {
    run: {
      ...run,
      generations: [[]],  // Start with empty generation
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
  
  // Send initial status update to UI immediately
  sendUpdate(runId, { type: 'status', status: 'running' });
  sendUpdate(runId, { type: 'generation', generation: 0, nodes: [] });
  
  // Generate initial population asynchronously (non-blocking)
  console.log('[Evaluation] Generating initial population...');
  
  // Callback to add nodes as they're created (real-time!)
  const onNodeCreated = (node: CandidateNode) => {
    console.log(`[Evaluation] Node created: ${node.id.slice(0, 8)}`);
    
    // Add to generation
    state.run.generations[0].push(node);
    
    // Add to queue
    state.queue.push(node);
    
    // Send node update immediately
    sendUpdate(runId, { type: 'node', node });
    
    // DON'T start evaluation loop yet - wait for ALL initial population to be ready
  };
  
  generateInitialPopulation(config, onNodeCreated).then(() => {
    console.log(`[Evaluation] Initial population generation complete - ${state.queue.length} nodes ready`);
    // NOW start the evaluation loop with ALL initial nodes
    if (state.status === 'running') {
      console.log(`[Evaluation] Starting evaluation loop...`);
      evaluationLoop(runId);
    }
  }).catch((error) => {
    console.error('[Evaluation] Failed to generate initial population:', error);
    sendUpdate(runId, { 
      type: 'error', 
      message: `Failed to generate initial population: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error'
    });
    finishEvaluation(runId, state);
  });
}

export function pauseEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'paused';
    state.run.status = 'paused';
    saveRunStatus(runId, state.run); // Save to DB
    sendUpdate(runId, { type: 'status', status: 'paused' });
  }
}

export function resumeEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'running';
    state.run.status = 'running';
    saveRunStatus(runId, state.run); // Save to DB
    sendUpdate(runId, { type: 'status', status: 'running' });
    evaluationLoop(runId);
  }
}

export function stopEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'stopped';
    state.run.status = 'stopped';
    state.run.stopReason = 'manual';
    state.run.finishedAt = Date.now();
    saveRunStatus(runId, state.run); // Save to DB
    activeEvaluations.delete(runId);
    
    sendUpdate(runId, { type: 'stop', reason: 'manual' });
  }
}

async function evaluationLoop(runId: UUID): Promise<void> {
  const state = activeEvaluations.get(runId);
  if (!state || state.status !== 'running') return;
  
  // Check termination conditions
  if (shouldStop(state)) {
    finishEvaluation(runId, state);
    return;
  }
  
  // Process ALL queued nodes (global semaphore limits actual API calls)
  // No need to limit nodes here since semaphore controls ALL API concurrency
  while (
    state.queue.length > 0 &&
    state.status === 'running'
  ) {
    const node = state.queue.shift()!;
    state.inProgress.add(node.id);
    
    // Process node asynchronously
    processNode(runId, node, state).then(() => {
      state.inProgress.delete(node.id);
      
      // Continue loop
      if (state.status === 'running') {
        evaluationLoop(runId);
      }
    });
  }
  
  // If queue is empty and nothing in progress, move to next generation
  if (state.queue.length === 0 && state.inProgress.size === 0) {
    await moveToNextGeneration(runId, state);
  }
}

async function processNode(
  runId: UUID,
  node: CandidateNode,
  state: EvaluationState
): Promise<void> {
  node.status = 'in_progress';
  node.timings = { startedAt: Date.now() };
  
  sendUpdate(runId, { type: 'node', node });
  
  try {
    // Check cache
    const cacheKey = getCacheKey(node, state.config.testSet);
    const cachedResults = state.cache.get(cacheKey);
    
    if (cachedResults) {
      node.tests = cachedResults;
      state.run.cacheHits++;
    } else {
      // Run tests (totals are updated inside runTests as each test completes)
      node.tests = await runTests(runId, node, state.config, state);
      state.cache.set(cacheKey, node.tests);
    }
    
    // Calculate total cost and latency for node metrics (already tracked in totals)
    let totalCost = 0;
    let totalLatency = 0;
    
    for (const test of node.tests) {
      // Get cost for node metrics display
      const { getModelCost } = await import('../providers/costs.js');
      const costEntry = await getModelCost(node.params.model);
      
      if (costEntry) {
        const promptCost = (test.promptTokens / 1000) * costEntry.promptUSDper1k;
        const completionCost = (test.completionTokens / 1000) * costEntry.completionUSDper1k;
        totalCost += promptCost + completionCost;
      }
      
      // Estimate latency based on tokens
      totalLatency += (test.promptTokens + test.completionTokens) * 10;
    }
    
    // Calculate safety if guardrails are configured
    let safety: number | undefined;
    if (state.config.fitness.guardrails && state.config.fitness.guardrails.length > 0) {
      const serviceAdapter = getProviderAdapter(state.config.serviceModel.provider);
      const { evaluateSafetyGuardrails } = await import('./fitness.js');
      
      // Evaluate guardrails against concatenated test outputs
      const allOutputs = node.tests.map(t => t.outputText || '').join('\n---\n');
      const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;
      const safetyResult = await evaluateSafetyGuardrails(
        allOutputs,
        state.config.fitness.guardrails,
        state.config.serviceModel,
        serviceAdapter,
        maxTokens
      );
      safety = safetyResult.score;
      
      // Track service model costs from guardrail checks
      trackServiceCost(state, safetyResult.totalCost, { prompt: safetyResult.totalPromptTokens, completion: safetyResult.totalCompletionTokens });
      
      // Send totals update after service model use
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    }
    
    // Calculate fitness
    node.metrics = {
      costUSD: totalCost,
      latencyMs: totalLatency,
      safety,
    };
    
    const fitnessResult = calculateFitness(node, state.config);
    node.metrics = { ...node.metrics, ...fitnessResult };
    
    // Update totals
    const totalTokens = node.tests.reduce(
      (acc, test) => ({
        prompt: acc.prompt + test.promptTokens,
        completion: acc.completion + test.completionTokens,
      }),
      { prompt: 0, completion: 0 }
    );
    
    state.run.totals.tokensPrompt += totalTokens.prompt;
    state.run.totals.tokensCompletion += totalTokens.completion;
    state.run.totals.usd += totalCost;
    state.run.totals.calls += node.tests.length;
    
    node.status = 'finished';
    node.timings.finishedAt = Date.now();
  } catch (error) {
    console.error(`Node processing failed for ${node.id}:`, error);
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);
    
    // Send error notification
    sendUpdate(runId, { 
      type: 'error', 
      message: `Node ${node.id.slice(0, 8)} failed: ${node.error}`,
      severity: 'warning'
    });
  }
  
  sendUpdate(runId, { type: 'node', node });
  sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
}

async function runTests(
  runId: UUID,
  node: CandidateNode,
  config: EvaluationConfig,
  state: EvaluationState
): Promise<TestResult[]> {
  const adapter = getProviderAdapter(node.params.model.provider);
  
  // Run ALL tests in parallel for this node
  const testPromises = config.testSet.map(async (test) => {
    try {
      // Combine candidate prompt (evolved system/instruction) with test input
      const combinedPrompt = `${node.prompt}\n\n${test.prompt}`;
      
      const maxTokens = (config as any).serviceModelMaxTokens || 20000;
      const result = await adapter.call({
        model: node.params.model.model,
        prompt: combinedPrompt,
        temperature: node.params.temperature,
        seed: node.params.seed,
        maxTokens, // Apply same max tokens to candidate models
      });
      
      let evaluation: { passed: boolean; score: number };
      
      if (test.mode === 'llm_grade') {
        // Use LLM grading via service model
        const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
        const { evaluateTestResultLLM } = await import('./fitness.js');
        const maxTokens = (config as any).serviceModelMaxTokens || 20000;
        
        const gradingResult = await evaluateTestResultLLM(
          test,
          node.prompt,
          test.prompt,
          result.output,
          config.serviceModel,
          serviceAdapter,
          maxTokens
        );
        
        evaluation = { passed: gradingResult.passed, score: gradingResult.score };
        
        // Track service model costs from LLM grading IMMEDIATELY
        trackServiceCost(state, gradingResult.usd, {
          prompt: gradingResult.promptTokens,
          completion: gradingResult.completionTokens
        });
        
        // Send totals update IMMEDIATELY after this test's grading
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
        
        return {
          testId: test.id,
          passed: evaluation.passed,
          score: evaluation.score,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          outputText: result.output,
          rawResponsePath: undefined,
        };
      } else {
        // Use exact match evaluation
        evaluation = evaluateTestResult(test, result.output, test.mode);
      }
      
      // Store raw blob if enabled
      let rawResponsePath: string | undefined;
      if (config.rawBlobCapture) {
        rawResponsePath = await storeRawBlob(
          runId,
          node.id,
          test.id,
          result
        );
      }
      
      // Track candidate model costs IMMEDIATELY after test completes
      const { getModelCost } = await import('../providers/costs.js');
      const costEntry = await getModelCost(node.params.model);
      
      if (costEntry) {
        const testCost = (result.promptTokens / 1000) * costEntry.promptUSDper1k +
                        (result.completionTokens / 1000) * costEntry.completionUSDper1k;
        
        trackServiceCost(state, testCost, {
          prompt: result.promptTokens,
          completion: result.completionTokens
        });
        
        // Send totals update IMMEDIATELY after this test completes
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      }
      
      return {
        testId: test.id,
        passed: evaluation.passed,
        score: evaluation.score,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        outputText: result.output,
        rawResponsePath,
      };
    } catch (error) {
      console.error(`Test failed for ${test.id}:`, error);
      
      // Send error notification for ALL errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      sendUpdate(runId, { 
        type: 'error', 
        message: `Test failed: ${errorMsg.substring(0, 150)}`,
        severity: 'error'
      });
      
      return {
        testId: test.id,
        passed: false,
        score: 0,
        promptTokens: 0,
        completionTokens: 0,
        outputText: `Error: ${errorMsg}`,
        rawResponsePath: undefined,
      };
    }
  });
  
  // Wait for all tests to complete in parallel
  const testResults = await Promise.all(testPromises);
  
  return testResults;
}

async function moveToNextGeneration(
  runId: UUID,
  state: EvaluationState
): Promise<void> {
  const currentGen = state.run.generations[state.currentGeneration];
  
  // Persist current generation to database
  await persistGeneration(runId, state);
  
  // Sort by fitness
  const sorted = currentGen
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => (b.metrics!.fitness! - a.metrics!.fitness!));
  
  if (sorted.length === 0) {
    finishEvaluation(runId, state);
    return;
  }
  
  // Select top performers based on policy
  let topPerformers: CandidateNode[];
  
  if (state.config.selection.policy === 'topk') {
    // Top-K: Select fixed number of best candidates
    const k = state.config.selection.topK || 4;
    topPerformers = sorted.slice(0, Math.min(k, sorted.length));
  } else {
    // Top-P: Select candidates until cumulative probability reaches threshold
    const p = state.config.selection.topP || 0.8;
    const totalFitness = sorted.reduce((sum, n) => sum + (n.metrics?.fitness || 0), 0);
    
    if (totalFitness === 0) {
      // Fallback: select at least one
      topPerformers = [sorted[0]];
    } else {
      let cumulativeProbability = 0;
      topPerformers = [];
      
      for (const node of sorted) {
        topPerformers.push(node);
        cumulativeProbability += (node.metrics?.fitness || 0) / totalFitness;
        
        if (cumulativeProbability >= p) {
          break;
        }
      }
      
      // Ensure at least one is selected
      if (topPerformers.length === 0) {
        topPerformers = [sorted[0]];
      }
    }
  }
  
  // Generate next generation
  const nextGen: CandidateNode[] = [];
  const nextGenNumber = state.currentGeneration + 1;
  
  const mutationCount = Math.ceil(state.config.population.size * state.config.operators.mutationFactor);
  const crossoverCount = Math.ceil(state.config.population.size * state.config.operators.crossoverFactor);
  const metaCount = state.config.operators.metaPrompting?.enabled
    ? Math.ceil(state.config.population.size * (state.config.operators.metaPrompting.share ?? 0))
    : 0;
  
  // Update lineage history and check for pruning
  updateLineageHistory(state, topPerformers);
  
  // Track operator effectiveness
  trackOperatorEffectiveness(state, currentGen);
  
  // Log operator effectiveness (V1: logging only, no policy changes)
  logOperatorEffectiveness(state);
  
  // Create mutations in parallel
  const mutationPromises = Array.from({ length: mutationCount }, async (_, i) => {
    const parent = topPerformers[i % topPerformers.length];
    
    // Check if this lineage should be pruned
    if (shouldPruneLineage(state, parent.id)) {
      const node: CandidateNode = {
        id: uuidv4(),
        generation: nextGenNumber,
        lineageParents: [parent.id],
        status: 'skipped',
        prompt: parent.prompt,
        params: parent.params,
        changeLog: [{ label: 'MUTATION' as const, text: 'Skipped due to stagnation' }],
      };
      return node;
    }
    
    try {
      const mutated = await applyMutation(parent, state.config);
      
      // Track service model costs from mutation
      trackServiceCost(state, mutated.totalCost, { 
        prompt: mutated.totalPromptTokens, 
        completion: mutated.totalCompletionTokens 
      });
      
      // Send totals update after service model use
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      
      const node: CandidateNode = {
        id: uuidv4(),
        generation: nextGenNumber,
        lineageParents: [parent.id],
        status: 'awaiting',
        prompt: mutated.prompt,
        params: parent.params,
        changeLog: mutated.changeLog,
      };
      return node;
    } catch (error) {
      console.error('Mutation failed:', error);
      sendUpdate(runId, { 
        type: 'error', 
        message: `Mutation failed: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning'
      });
      return null;
    }
  });
  
  // Create crossovers in parallel
  const crossoverPromises = Array.from({ length: crossoverCount }, async (_, i) => {
    const parentA = topPerformers[i % topPerformers.length];
    const parentB = topPerformers[(i + 1) % topPerformers.length];
    try {
      const crossed = await applyCrossover(parentA, parentB, state.config);
      
      // Track service model costs from crossover
      trackServiceCost(state, crossed.totalCost, { 
        prompt: crossed.totalPromptTokens, 
        completion: crossed.totalCompletionTokens 
      });
      
      // Send totals update after service model use
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      
      const node: CandidateNode = {
        id: uuidv4(),
        generation: nextGenNumber,
        lineageParents: [parentA.id, parentB.id],
        status: 'awaiting',
        prompt: crossed.prompt,
        params: parentA.params,
        changeLog: crossed.changeLog,
      };
      return node;
    } catch (error) {
      console.error('Crossover failed:', error);
      sendUpdate(runId, { 
        type: 'error', 
        message: `Crossover failed: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning'
      });
      return null;
    }
  });
  
  // Create meta-prompted nodes in parallel
  const metaPromises = Array.from({ length: metaCount }, async (_, i) => {
    const parent = topPerformers[i % topPerformers.length];
    try {
      const metaed = await applyMetaPrompting(parent, state.config);
      
      // Track service model costs from meta-prompting
      trackServiceCost(state, metaed.totalCost, { 
        prompt: metaed.totalPromptTokens, 
        completion: metaed.totalCompletionTokens
      });
      
      // Send totals update after service model use
      sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      
      const node: CandidateNode = {
        id: uuidv4(),
        generation: nextGenNumber,
        lineageParents: [parent.id],
        status: 'awaiting',
        prompt: metaed.prompt,
        params: parent.params,
        changeLog: metaed.changeLog,
      };
      return node;
    } catch (error) {
      console.error('Meta-prompting failed:', error);
      sendUpdate(runId, { 
        type: 'error', 
        message: `Meta-prompting failed: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning'
      });
      return null;
    }
  });
  
  // Wait for all genetic operators to complete in parallel
  const [mutatedNodes, crossedNodes, metaNodes] = await Promise.all([
    Promise.all(mutationPromises),
    Promise.all(crossoverPromises),
    Promise.all(metaPromises),
  ]);
  
  // Add all successful nodes to next generation (filter out nulls from errors)
  nextGen.push(...mutatedNodes.filter((n): n is CandidateNode => n !== null));
  nextGen.push(...crossedNodes.filter((n): n is CandidateNode => n !== null));
  nextGen.push(...metaNodes.filter((n): n is CandidateNode => n !== null));
  
  // Ensure we have at least some nodes
  if (nextGen.length === 0) {
    finishEvaluation(runId, state);
    return;
  }
  
  state.run.generations.push(nextGen);
  state.currentGeneration++;
  state.queue = [...nextGen];
  
  // Continue evaluation
  evaluationLoop(runId);
}

function shouldStop(state: EvaluationState): boolean {
  const targets = state.config.targets;
  
  // Check time limit
  if (targets.timeLimitMs) {
    const elapsed = Date.now() - state.run.startedAt;
    if (elapsed >= targets.timeLimitMs) {
      state.run.stopReason = 'time';
      return true;
    }
  }
  
  // Check budget limit
  if (targets.budgetUSD && state.run.totals.usd >= targets.budgetUSD) {
    state.run.stopReason = 'budget';
    return true;
  }
  
  // Check fitness target
  if (targets.targetFitness) {
    const currentGen = state.run.generations[state.currentGeneration];
    const maxFitness = Math.max(
      ...currentGen
        .filter(n => n.metrics?.fitness !== undefined)
        .map(n => n.metrics!.fitness!)
    );
    
    if (maxFitness >= targets.targetFitness) {
      state.run.stopReason = 'target';
      return true;
    }
  }
  
  // Check max generations
  if (targets.maxGenerations && state.currentGeneration >= targets.maxGenerations) {
    state.run.stopReason = 'generations';
    return true;
  }
  
  return false;
}

async function finishEvaluation(runId: UUID, state: EvaluationState): Promise<void> {
  state.run.finishedAt = Date.now();
  state.status = 'stopped';
  
  if (!state.run.stopReason) {
    state.run.stopReason = 'exhausted';
  }
  
  // Final persistence
  await persistGeneration(runId, state);
  
  activeEvaluations.delete(runId);
  sendUpdate(runId, { type: 'stop', reason: state.run.stopReason });
}

async function persistGeneration(runId: UUID, state: EvaluationState): Promise<void> {
  const { getDatabase } = await import('../database/init.js');
  const db = getDatabase();
  
  // Start transaction for atomic batch update
  const transaction = db.transaction(() => {
    // Update run
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?, finished_at = ?, stop_reason = ?
      WHERE id = ?
    `).run(
      JSON.stringify(state.run),
      state.run.finishedAt || null,
      state.run.stopReason || null,
      runId
    );
    
    // Insert/update nodes for current generation
    const currentGen = state.run.generations[state.currentGeneration];
    const nodeInsert = db.prepare(`
      INSERT OR REPLACE INTO candidate_nodes (id, run_id, generation, status, fitness, node_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    for (const node of currentGen) {
      nodeInsert.run(
        node.id,
        runId,
        node.generation,
        node.status,
        node.metrics?.fitness || null,
        JSON.stringify(node)
      );
    }
    
    // Insert cost ledger entries for new nodes
    const costInsert = db.prepare(`
      INSERT INTO cost_ledger (run_id, node_id, provider, model, prompt_tokens, completion_tokens, usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const node of currentGen) {
      if (node.tests && node.metrics?.costUSD) {
        const totalPromptTokens = node.tests.reduce((sum, t) => sum + t.promptTokens, 0);
        const totalCompletionTokens = node.tests.reduce((sum, t) => sum + t.completionTokens, 0);
        
        costInsert.run(
          runId,
          node.id,
          node.params.model.provider,
          node.params.model.model,
          totalPromptTokens,
          totalCompletionTokens,
          node.metrics.costUSD,
          Date.now()
        );
      }
    }
  });
  
  transaction();
}

function getCacheKey(node: CandidateNode, testSet: TestCase[]): string {
  const data = {
    prompt: node.prompt,
    model: node.params.model,
    temperature: node.params.temperature,
    testSet: testSet.map(t => ({ id: t.id, prompt: t.prompt })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function sendUpdate(runId: UUID, data: any): void {
  console.log(`[sendUpdate] Sending to eval:updates:${runId}:`, data.type);
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send(`eval:updates:${runId}`, data);
  } else {
    console.warn('[sendUpdate] No main window found!');
  }
}

// Helper to save just the run status to DB (for pause/resume/stop)
function saveRunStatus(runId: UUID, run: EvaluationRun): void {
  import('../database/init.js').then(({ getDatabase }) => {
    const db = getDatabase();
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?, finished_at = ?, stop_reason = ?
      WHERE id = ?
    `).run(
      JSON.stringify(run),
      run.finishedAt || null,
      run.stopReason || null,
      runId
    );
  });
}

async function storeRawBlob(
  runId: UUID,
  nodeId: UUID,
  testId: UUID,
  result: any
): Promise<string> {
  const { getDatabase } = await import('../database/init.js');
  const { v4: uuidv4 } = await import('uuid');
  const db = getDatabase();
  
  const blobId = uuidv4();
  const blobData = JSON.stringify({
    output: result.output,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
    timestamp: Date.now(),
  });
  
  db.prepare(`
    INSERT INTO raw_blobs (id, run_id, node_id, test_id, blob_data, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(blobId, runId, nodeId, testId, blobData, Date.now());
  
  return blobId;
}

// Branch pruning: track lineage improvements
const STAGNATION_THRESHOLD = 3; // Prune after 3 generations with no improvement

function updateLineageHistory(
  state: EvaluationState,
  topPerformers: CandidateNode[]
): void {
  for (const node of topPerformers) {
    const currentFitness = node.metrics?.fitness || 0;
    
    if (!state.lineageHistory.has(node.id)) {
      state.lineageHistory.set(node.id, {
        bestFitness: currentFitness,
        stagnantGenerations: 0,
      });
    } else {
      const history = state.lineageHistory.get(node.id)!;
      
      if (currentFitness > history.bestFitness) {
        // Improvement detected
        history.bestFitness = currentFitness;
        history.stagnantGenerations = 0;
      } else {
        // No improvement
        history.stagnantGenerations++;
      }
    }
    
    // Track parent lineages
    for (const parentId of node.lineageParents) {
      if (state.lineageHistory.has(parentId)) {
        const parentHistory = state.lineageHistory.get(parentId)!;
        if (currentFitness > parentHistory.bestFitness) {
          state.lineageHistory.set(node.id, {
            bestFitness: currentFitness,
            stagnantGenerations: 0,
          });
        } else {
          state.lineageHistory.set(node.id, {
            bestFitness: parentHistory.bestFitness,
            stagnantGenerations: parentHistory.stagnantGenerations + 1,
          });
        }
      }
    }
  }
}

function shouldPruneLineage(state: EvaluationState, nodeId: UUID): boolean {
  const history = state.lineageHistory.get(nodeId);
  if (!history) return false;
  
  return history.stagnantGenerations >= STAGNATION_THRESHOLD;
}

// Track operator effectiveness: log average Δfitness per operator
function trackOperatorEffectiveness(
  state: EvaluationState,
  currentGen: CandidateNode[]
): void {
  for (const node of currentGen) {
    if (node.status !== 'finished' || !node.metrics?.fitness) continue;
    
    // Find parent fitness
    if (node.lineageParents.length === 0) continue;
    
    const parentId = node.lineageParents[0];
    let parentFitness = 0;
    
    // Look for parent in previous generation
    if (state.currentGeneration > 0) {
      const prevGen = state.run.generations[state.currentGeneration - 1];
      const parent = prevGen.find(n => n.id === parentId);
      if (parent && parent.metrics?.fitness) {
        parentFitness = parent.metrics.fitness;
      }
    }
    
    const delta = node.metrics.fitness - parentFitness;
    
    // Determine primary operator from changelog
    const primaryOp = node.changeLog[0]?.label;
    switch (primaryOp) {
      case 'MUTATION':
        state.operatorEffectiveness.mutation.totalDelta += delta;
        state.operatorEffectiveness.mutation.count++;
        break;
      case 'CROSSOVER':
        state.operatorEffectiveness.crossover.totalDelta += delta;
        state.operatorEffectiveness.crossover.count++;
        break;
      case 'META':
        state.operatorEffectiveness.meta.totalDelta += delta;
        state.operatorEffectiveness.meta.count++;
        break;
      case 'PARAM':
        state.operatorEffectiveness.param.totalDelta += delta;
        state.operatorEffectiveness.param.count++;
        break;
    }
  }
}

function logOperatorEffectiveness(state: EvaluationState): void {
  const eff = state.operatorEffectiveness;
  
  console.log('=== Operator Effectiveness (Generation', state.currentGeneration, ') ===');
  
  if (eff.mutation.count > 0) {
    const avg = eff.mutation.totalDelta / eff.mutation.count;
    console.log(`  MUTATION: Avg Δfitness = ${avg.toFixed(4)} (n=${eff.mutation.count})`);
  }
  
  if (eff.crossover.count > 0) {
    const avg = eff.crossover.totalDelta / eff.crossover.count;
    console.log(`  CROSSOVER: Avg Δfitness = ${avg.toFixed(4)} (n=${eff.crossover.count})`);
  }
  
  if (eff.meta.count > 0) {
    const avg = eff.meta.totalDelta / eff.meta.count;
    console.log(`  META: Avg Δfitness = ${avg.toFixed(4)} (n=${eff.meta.count})`);
  }
  
  if (eff.param.count > 0) {
    const avg = eff.param.totalDelta / eff.param.count;
    console.log(`  PARAM: Avg Δfitness = ${avg.toFixed(4)} (n=${eff.param.count})`);
  }
}

