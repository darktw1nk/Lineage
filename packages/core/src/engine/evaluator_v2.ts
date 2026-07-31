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
import { calculateFitness, resetFitnessWarnings } from './fitness.js';
import { resetStructuredWarnings } from './structured.js';
import { store } from '../store.js';
import { recordSpend, readSpend, clearSpend } from './spendledger.js';
import { getDatabase } from '../database/init.js';

interface EvaluationState {
  /**
   * Ungraded SAMPLES seen per node, keyed by node id.
   *
   * A node that fails mid-evaluation never gets a `tests` array, so its
   * grading failures are invisible to a leaf sweep. Keeping the tally here
   * lets the sweep stay authoritative — the alternative, maxing against a
   * process-lifetime counter, mixes SAMPLES with TEST RESULTS and double-counts
   * every replayed node on a resume.
   */
  ungradedByNode: Map<UUID, number>;
  run: EvaluationRun;
  config: EvaluationConfig;
  status: 'running' | 'pausing' | 'paused' | 'stopped';
  currentGeneration: number;
  queue: CandidateNode[];
  inProgress: Set<UUID>;
  cache: Map<string, TestResult[]>;
  /** Evaluations currently running, keyed the same way, so duplicates join rather than re-pay. */
  inFlightEvaluations: Map<string, Promise<TestResult[]>>;
  lineageHistory: Map<UUID, { bestFitness: number; stagnantGenerations: number }>;
  operatorEffectiveness: Record<string, { totalDelta: number; count: number }>;
  fitnessTests: TestCase[];   // tests visible to evolution
  holdoutTests: TestCase[];   // reserved for the final generalization report
  samplesPerTest: number;     // resolved + clamped from config
  promptMode: 'system' | 'inline'; // resolved from config (default 'system')
  pairwiseEnabled: boolean;   // opt-in pairwise playoff
  pairwiseContenders: number; // resolved + clamped (2..8) from config
  costContext: 'evolution' | 'holdout'; // routes accruals to holdout labels during the final evaluation
  finishing: boolean;
  /** Warn once, not per node, when stability is weighted but unmeasurable. */
  warnedStabilityNeedsSamples: boolean;
  /** Warn once when the token cap, not the model, is ending replies. */
  warnedTruncation: boolean;
  /** Models already warned about reporting $0 for real tokens. */
  warnedZeroCostModels: Set<string>;
  /** A Stop was requested — checked between billable phases so spending actually halts. */
  stopRequested: boolean;         // idempotency latch: finishEvaluation must run exactly once
  loopRunning: boolean;       // re-entrancy guard: exactly one evaluationLoop per state
  pausedAt?: number; // Timestamp when paused (if currently paused)
  totalPausedMs: number; // Total time spent paused
  gradingTotal: number; // Total grading calls completed
  gradingFailures: number; // Grading calls that failed to parse JSON
  // The predictive-reservation state (reservedUSD, callCeilingUSD,
  // observedCompletion, maxObservedCallUSD) was deleted in pass 20's cleanup:
  // the reservation model was reverted to a settled-spend gate long ago and
  // pass-20's hunter proved the fields were written but never read anywhere.
  // reserveCall's comment records why prediction was abandoned; do not
  // reintroduce these without measuring both failure directions.
  /** Calls that threw. Their provider-side spend, if any, is unknowable here. */
  failedCalls: number;
  /** Times the cap REFUSED a call. Settled spend can sit below the cap while this climbs. */
  budgetRefusals: number;
  /** Wall clock of the last per-node checkpoint, and what it cost — see maybeCheckpointNode. */
  lastNodeCheckpointAt: number;
  lastCheckpointCostMs: number;
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
function recalculateAllFitness(runId: UUID, state: EvaluationState, justFinished?: CandidateNode): void {
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
  let emitted = 0;
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
      // Only nodes whose fitness ACTUALLY moved, plus the one that just
      // finished (whose first update this is).
      //
      // This used to emit one node_updated per already-finished node on every
      // node completion — n^2/2 events. Measured on 6 generations x 30 nodes:
      // 369 events in absolute mode, 15,574 in relative mode (42x), matching
      // n^2/2 exactly. Extrapolated to 600 nodes that is ~180,000 events, each
      // carrying a full node (250 KB with large outputs) over IPC, each
      // rebuilding the whole React Flow graph and printing a CLI line. A new
      // max only changes the normalizer when it actually rises, so the vast
      // majority of those events carried no change at all.
      if (fitnessChanged || node === justFinished) {
        sendUpdate(runId, { type: 'node_updated', node });
        emitted++;
      }
    }
  }

  console.log(`[Fitness Recalc] Sent ${emitted} update(s) across ${finishedNodes.length} nodes (${recalculated} changed)`);
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

  // Claim the id SYNCHRONOUSLY, before any await.
  //
  // The guard used to check `activeEvaluations` and then register the state
  // several awaits later (dynamic imports, a model-cost lookup, the holdout
  // partition). Two starts for one run id landing in adjacent event-loop turns
  // therefore both passed, both built a state, and the second overwrote the
  // first — producing a double population, double fill spend, and a run wedged
  // at 'running' forever because the surviving loop was waiting on the
  // discarded state's queue. Reproduced 4/4 at <2ms separation, which is
  // reachable from two programmatic or IPC starts (not a human double-click).
  if (startingRuns.has(runId) || activeEvaluations.has(runId)) {
    throw new Error('Evaluation already running');
  }
  startingRuns.add(runId);
  try {
    await startEvaluationInner(runId, config, run);
  } finally {
    startingRuns.delete(runId);
  }
}

/** Run ids between the start request and their state being registered. */
const startingRuns = new Set<UUID>();

async function startEvaluationInner(
  runId: UUID,
  config: EvaluationConfig,
  run: EvaluationRun
): Promise<void> {

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
  // The semaphore is process-global and shared by every concurrent run, so a
  // starting run must never LOWER the ceiling another run is already using.
  // initGlobalSemaphore was last-writer-wins: starting a parallelLimit-1 run
  // beside a parallelLimit-8 one dropped the big run to 1-way concurrency for
  // the rest of its life, and nothing ever raised it back. Take the max of
  // every live run instead; each run's own dispatch loop still honours its own
  // parallelLimit, so this only stops cross-run interference.
  const liveLimits = [...activeEvaluations.values()].map(s => s.config.parallelLimit || 1);
  initGlobalSemaphore(Math.max(globalLimit, ...liveLimits));
  console.log(`[Evaluator] Global API limit: ${Math.max(globalLimit, ...liveLimits)} (this run: ${globalLimit})`);

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
  // Holdout split: explicit holdoutSeed, else a FIXED 42 — deliberately NOT
  // config.seed. Coupling them silently re-partitioned the holdout whenever the
  // run seed changed, so the documented paired-run method (same config, two
  // seeds) compared two arms scored on DIFFERENT held-out tests, which makes
  // the comparison meaningless. docs/cli.md already documents the default as 42.
  const holdoutShare = config.holdoutShare ?? 0;
  const { fitnessTests, holdoutTests } = partitionTestSet(config.testSet, holdoutShare, config.holdoutSeed ?? 42);
  if (fitnessTests.length === 0) {
    throw new Error('Holdout configuration leaves no fitness tests');
  }
  if (holdoutTests.length > 0) {
    console.log(`[Evaluator] Holdout: ${holdoutTests.length} test(s) reserved (${holdoutTests.map(t => t.name).join(', ')})`);
  } else if (holdoutShare > 0) {
    // floor(tests * share) rounds down to zero on small test sets — the user
    // asked for a generalization check, got none, and the report simply omitted
    // the section. The holdout is the ONLY defence against reading a
    // selected-for training delta as a real improvement, so say so loudly.
    console.warn(
      `[Evaluator] holdoutShare ${holdoutShare} over ${config.testSet.length} test(s) rounds down to ZERO held-out tests — ` +
      `no generalization check will run. Add more tests, raise holdoutShare, or mark a test "holdout": true explicitly.`,
    );
    run.holdoutSkippedReason = 'share-rounds-to-zero';
  }
  const pairwiseEnabled = config.pairwise?.enabled === true;
  // A playoff judges stored outputs head-to-head, which only makes sense for
  // llm_grade tests — the deterministic modes already give a crisp score. With
  // none, maybeRunPlayoff returned early and NOTHING was logged, so an enabled
  // playoff simply never happened and the user had no way to notice.
  if (pairwiseEnabled && !config.testSet.some(t => (t.mode ?? 'llm_grade') === 'llm_grade')) {
    console.warn(
      '[Playoff] pairwise is enabled but no test uses mode "llm_grade" — the playoff needs judged ' +
      'outputs to compare, so it will not run. Deterministic modes already produce a precise score.',
    );
  }
  const rawContenders = config.pairwise?.contenders ?? 4;
  const pairwiseContenders = Math.min(Math.max(Math.floor(rawContenders), 2), 8);
  if (pairwiseEnabled && pairwiseContenders !== rawContenders) {
    console.warn(`[Playoff] contenders clamped from ${rawContenders} to ${pairwiseContenders}`);
  }

  // Compute the downtime credit BEFORE the state literal. `run: { ...run }` is
  // a shallow copy taken at literal-evaluation time, and object keys evaluate in
  // order — so a later key that mutates `run` writes to an object `state.run` no
  // longer shares, and persistRun (which serialises state.run) never saw it. The
  // credit then vanished at the first checkpoint and the SECOND resume was
  // killed on arrival by timeLimitMs. Assign it to BOTH explicitly.
  const adjustedPausedMs = resumeAdjustedPausedMs(run, isResume);

  // Warnings are once-per-run, not once-per-process: a second run in the same
  // CLI/Electron process must still be told its cost dimension is disabled.
  resetFitnessWarnings();
  resetStructuredWarnings();

  // A seed promises reproducibility, and docs/cli.md's paired-run method
  // depends on it — but latency is measured wall clock and relative-mode norms
  // depend on what the rest of the generation happened to cost, so both make
  // fitness a function of machine load. Measured: identical config and seed
  // produced different champions, different models and a different best
  // prompt. Say so rather than letting the comparison look controlled.
  if (config.seed !== undefined) {
    const nondeterministic = [
      (config.fitness.weights.latency ?? 0) > 0 ? 'latency' : null,
      config.fitness.costNorm?.mode === 'relative' && (config.fitness.weights.cost ?? 0) > 0 ? 'cost (relative)' : null,
      config.fitness.latencyNorm?.mode === 'relative' && (config.fitness.weights.latency ?? 0) > 0 ? 'latency (relative)' : null,
    ].filter(Boolean);
    if (nondeterministic.length > 0) {
      console.warn(
        `[Evaluator] seed is set, but the ${nondeterministic.join(' and ')} weight(s) score against measured wall clock ` +
        `or against whatever the rest of the generation happened to cost — so this run is NOT reproducible. ` +
        `Drop those weights for a paired-seed comparison.`,
      );
    }
  }

  // Initialize state
  const state: EvaluationState = {
    run: {
      ...run,
      generations: isResume ? run.generations : [[]],
      status: 'running',
      totalPausedMs: adjustedPausedMs,
      graderFingerprint: run.graderFingerprint ?? graderFingerprint(),
    },
    config,
    status: 'running',
    currentGeneration: 0,
    queue: [],
    inProgress: new Set(),
    cache: new Map(),
    inFlightEvaluations: new Map(),
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
    warnedStabilityNeedsSamples: false,
    warnedTruncation: false,
    warnedZeroCostModels: new Set(),
    budgetRefusals: 0,
    failedCalls: 0,
    lastNodeCheckpointAt: 0, // 0 => the first node always checkpoints
    lastCheckpointCostMs: 0,
    stopRequested: false,
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
    totalPausedMs: adjustedPausedMs,
    gradingTotal: 0,
    ungradedByNode: new Map(),
    gradingFailures: 0,
  };

  activeEvaluations.set(runId, state);

  // Send running status
  sendUpdate(runId, { type: 'status', status: 'running' });
  console.log(`[Evaluator] Status sent: running`);

  // Adopt any spend the sidecar recorded after the last checkpoint. Taking the
  // LARGER of the two means a stale or missing sidecar can only under-report;
  // it can never invent spend.
  //
  // NOT gated on isResume. `isResume` is `run.generations.length > 0`, and the
  // initial population fill only checkpoints AFTER every mutation completes —
  // so a crash during the fill leaves `generations: []`, this recovery was
  // skipped, and the sidecar's durable record was overwritten from zero on the
  // next attempt. Measured with a $0.0004 cap and four kills during the fill:
  // the run reported $0.000430 while the wire log showed $0.0011997 actually
  // billed — 3.0x the cap, and it scales linearly with restarts. The CLI even
  // printed "0 finished nodes, $0.0000 already spent" while the sidecar on disk
  // said otherwise. Recovering spend is always safe; it never continues work.
  try {
    const ledger = readSpend(getDatabase().dbPath, state.run.id);
    if (ledger && ledger.totals.usd > state.run.totals.usd) {
      const lost = ledger.totals.usd - state.run.totals.usd;
      const lostCalls = ledger.totals.calls - state.run.totals.calls;
      console.warn(
        `[Evaluator] Recovered $${lost.toFixed(6)} over ${lostCalls} call(s) billed after the last checkpoint. ` +
        `Without this they would be charged by the provider but invisible to totals and to budgetUSD.`,
      );
      state.run.totals = { ...ledger.totals };
      if (ledger.costBreakdown) state.run.costBreakdown = ledger.costBreakdown;
    }
  } catch { /* advisory only */ }

  if (isResume) {
    const nowFingerprint = graderFingerprint();
    if (state.run.graderFingerprint && state.run.graderFingerprint !== nowFingerprint) {
      activeEvaluations.delete(runId);
      throw new Error(
        'Cannot resume: the system prompts (grading rubric / mutation strategies) differ from the ones this run started with. ' +
        'Scores from two rubrics are not comparable — selection and champion choice would silently mix them. ' +
        'Re-run with the ORIGINAL config (CLI: --config <the config used to start the run>), or start a fresh run.',
      );
    }
    state.run.graderFingerprint = nowFingerprint;

    // moveToNextGeneration pushes an EMPTY generation, then awaits
    // createNextGeneration to fill it. A crash in that window checkpoints a run
    // whose last generation is `[]` — and an empty generation reads as
    // "generation complete" everywhere downstream, so the resume selected from
    // nothing, did no work at all, and finished as `exhausted` with an empty
    // array in results.json while maxGenerations was nowhere near reached. The
    // generation was never populated, so dropping it loses nothing.
    while (state.run.generations.length > 1 && state.run.generations[state.run.generations.length - 1].length === 0) {
      state.run.generations.pop();
      console.warn('[Evaluator] Resume: dropped a trailing empty generation left by an interrupted transition');
    }
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
      mutatePopulationInBackground(runId, state).catch(err => onBackgroundFillCrash(runId, err));
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
  mutatePopulationInBackground(runId, state).catch(err => onBackgroundFillCrash(runId, err));
  
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
      // Stop means STOP. fillNode gated only on the budget, and fill nodes are
      // never added to `inProgress` — which is the only thing finishEvaluation
      // drains. So a Stop during the initial fill reported the run finished
      // with 0 calls and then made 2x(initialSize-1) paid service calls with no
      // UI left to interrupt them, and `eval:delete`'s drain exited on its first
      // poll because isEvaluationActive had already gone false.
      if (state.status === 'stopped' || state.status === 'pausing') {
        node.status = 'awaiting';
        node.changeLog = [{ label: 'CARRY', text: 'Run stopped before mutation' }];
        sendUpdate(runId, { type: 'node_updated', node });
        return;
      }

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
      // reserveCall is a settled-spend CHECK, not a reservation. The
      // between-calls protection comes from the shouldAbort gate passed to
      // mutateNode below, which sees the operator's own unsettled spend.
      await reserveCall(state);
      const result = await mutateNode(
        shellNodes[0].prompt,
        state.config,
        rngFor(state.config.seed, 'fill', gen0Index),
        // Between its own billed calls the operator asks whether its
        // unsettled spend has crossed the cap — the gate above only ran once.
        (spentSoFarUSD = 0) =>
          budgetExhausted(state, spentSoFarUSD) ||
          state.status === 'stopped' || state.status === 'pausing',
      );

      // Update node
      node.prompt = result.prompt;
      node.changeLog = result.changeLog;
      node.status = 'awaiting';

      // A fill that carried the seed forward duplicates node 0's measurement —
      // but seeded runs derive a DIFFERENT provider seed per gen-0 sibling, so
      // the identical prompt missed the cache and was re-billed in full
      // (open-bugs 2026-07-31 #1: 25% of the observed generation). Align the
      // params with node 0 so the cache / in-flight dedup serves it instead.
      const seedNode = shellNodes[0];
      if (
        node.prompt === seedNode.prompt &&
        JSON.stringify(node.params.model) === JSON.stringify(seedNode.params.model) &&
        node.params.temperature === seedNode.params.temperature
      ) {
        if (seedNode.params.seed === undefined) delete node.params.seed;
        else node.params.seed = seedNode.params.seed;
      }


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
      // A refused reservation is the cap working, not a failure. Falling into
      // the generic handler below marked the node `failed` while leaving its
      // shell changelog reading "Waiting for mutation..." — so the node was
      // destroyed AND the reason was invisible. Measured 5 of 8 generation-0
      // nodes lost this way on a budget 2.6x the run's true cost. The
      // generation-transition path (generation.ts) already carries correctly.
      if (error instanceof BudgetExhaustedError) {
        console.warn(`[Evaluator] Budget exhausted before mutating ${node.id.slice(0, 8)} — carrying the seed prompt forward`);
        node.status = 'awaiting';
        node.changeLog = [{ label: 'CARRY', text: 'Budget exhausted before mutation' }];
        sendUpdate(runId, { type: 'node_updated', node });
        return;
      }
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
    // Persist the tally ON THE NODE. A process-local Map cannot cross a restart,
    // so a node that failed BEFORE a crash contributed 0 on resume — the same
    // undercount from two rounds earlier, reintroduced for the case that matters
    // most. The node goes into the checkpoint; the Map does not.
    const failedTally = state.ungradedByNode.get(node.id);
    if (failedTally) (node as any).ungradedTests = failedTally;
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
 * Last-resort handler for the population fill.
 *
 * mutatePopulationInBackground is fire-and-forget, and two of its sendUpdate
 * calls sit outside its own try/catch — so a host whose sendUpdate throws
 * ("Object has been destroyed", which is exactly what webContents.send does on
 * a closed window) produced an unhandled rejection. Node kills the process on
 * those: a paid CLI run aborted mid-flight, or the Electron main process died.
 * Its sibling startEvaluationLoop was given this guard; this one was missed.
 */
function onBackgroundFillCrash(runId: UUID, error: unknown): void {
  console.error(`[Evaluator] Population fill crashed for ${runId.slice(0, 8)}:`, error);
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'stopped';
    state.run.status = 'stopped';
    state.run.stopReason = 'error';
    state.run.finishedAt = Date.now();
    try { persistRun(state); } catch { /* nothing more we can do */ }
    activeEvaluations.delete(runId);
  }
  try {
    sendUpdate(runId, { type: 'error', message: `Population fill failed: ${error instanceof Error ? error.message : String(error)}` });
    // 'stopped' AND then 'finished'. The CLI resolves its finishedPromise only
    // on 'finished' (packages/cli/src/engine.ts), so a crash here left it
    // awaiting a promise that never settled: no results.json, no report, and
    // Node exiting 0 once the loop drained — a paid run reporting success with
    // nothing to show. 'stopped' stays first so any listener watching for it
    // still sees it.
    sendUpdate(runId, { type: 'status', status: 'stopped' });
    sendUpdate(runId, { type: 'status', status: 'finished' });
  } catch {
    // The host's sendUpdate is what failed in the first place.
  }
}

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
    // 'stopped' AND then 'finished'. The CLI resolves its finishedPromise only
    // on 'finished' (packages/cli/src/engine.ts), so a crash here left it
    // awaiting a promise that never settled: no results.json, no report, and
    // Node exiting 0 once the loop drained — a paid run reporting success with
    // nothing to show. 'stopped' stays first so any listener watching for it
    // still sees it.
    sendUpdate(runId, { type: 'status', status: 'stopped' });
    sendUpdate(runId, { type: 'status', status: 'finished' });
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
          setStopReason(state, 'generations');
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
    
    // Stability, read from the samples this node already produced. It used to
    // make 3 EXTRA candidate calls per node — 26% of a run's calls — to measure
    // the variance of reply LENGTH, which is not reliability. Free now.
    let stabilityScore: number | undefined = undefined;
    if (state.config.fitness.weights.stability) {
      const { calculateStabilityFromSamples } = await import('./fitness.js');
      stabilityScore = calculateStabilityFromSamples(node);
      if (stabilityScore === undefined && !state.warnedStabilityNeedsSamples) {
        state.warnedStabilityNeedsSamples = true;
        console.warn(
          '[Evaluator] A "stability" weight is set but samplesPerTest is 1, so there is no repeat ' +
          'measurement to compare — the stability dimension is inactive. Set samplesPerTest to 2 or more.',
        );
      }
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
      recalculateAllFitness(runId, state, node);
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
      setStopReason(state, 'budget');
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

  maybeCheckpointNode(state); // self-throttling: see the function's comment
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
    // A COPY: handing back the stored array meant two nodes shared one mutable
    // results object.
    return state.cache.get(cacheKey)!.map(r => ({ ...r }));
  }

  // Register the in-flight evaluation BEFORE awaiting it, so siblings with an
  // identical key wait for this call instead of making their own. The entry was
  // only written after the await resolved, and the loop dispatches the whole
  // batch in one tick — so every duplicate prompt in a generation missed and
  // paid in full. Measured on an ordinary run: 6 candidate calls at
  // parallelLimit 1 versus 18 at parallelLimit 6, +75% total spend for the same
  // population. The default parallelLimit is 5.
  let inFlight = state.inFlightEvaluations.get(cacheKey);
  if (inFlight) {
    console.log(`[Evaluator] Node ${node.id.slice(0, 8)} joining an identical in-flight evaluation`);
    state.run.cacheHits++;
    sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
    return (await inFlight).map(r => ({ ...r }));
  }

  inFlight = evaluatePromptOnTests(node.prompt, node.params, state.fitnessTests, state, runId, node.id);
  state.inFlightEvaluations.set(cacheKey, inFlight);
  let results: TestResult[];
  try {
    results = await inFlight;
  } finally {
    // Failures must not be cached, and must not leave joiners waiting forever.
    state.inFlightEvaluations.delete(cacheKey);
  }

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
  /** Node these tests belong to, so a grading failure can be tallied against it. */
  nodeId?: UUID,
): Promise<TestResult[]> {
  const adapter = getProviderAdapter(params.model.provider);
  const maxTokens = (state.config as any).serviceModelMaxTokens || 20000;

  return Promise.all(tests.map(async (test) => {
    const samples = await Promise.all(
      Array.from({ length: state.samplesPerTest }, (_v, i) =>
        runSingleSample(test, candidatePrompt, params, i, state, runId, adapter, maxTokens, nodeId)),
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
      // Only GRADED samples. An ungraded sample's score is the placeholder 5.0,
      // and three identical placeholders read as zero spread — a perfect 10/10
      // stability derived from numbers no judge produced. Measured end to end:
      // two candidates the honest judge scored identically ([1,10,1]) diverged
      // to stability 5.757 vs 10.000, and the one that poisoned its own grading
      // became the champion the user takes away. Quality already scores an
      // ungraded test 0; stability has to refuse it too, or the free value just
      // moves to the dimension that still accepts it.
      ...(state.samplesPerTest > 1
        ? { samples: samples.filter(s => !(s as any).ungraded).map(s => s.score) }
        : {}),
      // Carry the flag up from the samples. runSingleSample set it on its own
      // internal return and this literal rebuilt the TestResult from scratch,
      // so `ungraded` was written in exactly one place and read nowhere:
      // results.json still showed a bare "score": 5 indistinguishable from a
      // judge that genuinely said 5. If ANY sample was ungraded, the mean is
      // part-fabricated and the leaf has to say so.
      ...(samples.some(s => (s as any).ungraded) ? { ungraded: true } : {}),
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
  nodeId?: UUID,
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
        const imgBuf = fs.readFileSync(test.image);
        // The file must actually BE an image. A config file names this path and
        // the bytes are uploaded to a third-party API, so an unchecked read
        // turned any config into an exfiltration primitive: `"image":
        // "../../.ssh/id_rsa"` was base64'd, labelled image/png and sent. The
        // MIME type now comes from the content rather than the extension.
        const mimeType = sniffImageMimeType(imgBuf);
        if (!mimeType) {
          throw new Error(
            `"${test.image}" is not a PNG, JPEG, GIF or WebP image. ` +
            `Test images are uploaded to the model provider, so only real image files are read.`,
          );
        }
        const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
        if (imgBuf.length > MAX_IMAGE_BYTES) {
          throw new Error(`"${test.image}" is ${(imgBuf.length / 1e6).toFixed(1)} MB — test images are capped at 20 MB.`);
        }
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

    // The settled-spend gate, checked immediately before the billable call.
    await reserveCall(state);
    let result;
    try {
      result = await adapter.call({
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
    } catch (callErr) {
      // A throw used to skip accrueCost entirely, so a failing provider served
      // calls that appeared nowhere in totals, the breakdown, the report or the
      // budget check. Measured: 37 real calls reported as 32.
      if (!(callErr instanceof BudgetExhaustedError)) {
        state.failedCalls++;
        accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdout : COST_LABELS.candidates,
          params.model, { usd: 0, promptTokens: 0, completionTokens: 0, calls: 1 });
      }
      throw callErr;
    }

    // A reply the CAP ended, not the model, is not a bad answer — but every
    // downstream scorer treats it as one. A json_schema test on a cut-off reply
    // scored 0/10 with "invalid JSON: no parseable JSON found in the response",
    // naming nothing, so the user rewrites the prompt to fix a setting.
    if (result.truncated && !state.warnedTruncation) {
      state.warnedTruncation = true;
      console.warn(
        `[Evaluator] ${params.model.provider}/${params.model.model} hit the ${maxTokens}-token cap mid-reply. ` +
        `Cut-off answers are scored as-is, so results are misleading until you raise serviceModelMaxTokens.`,
      );
    }

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
    let ungraded = false;
    
    if (test.mode === 'llm_grade') {
      // Grading is a second billable call per sample — gate it too
      if (budgetExhausted(state)) {
        throw new BudgetExhaustedError();
      }
      const { evaluateTestResultLLM } = await import('./fitness.js');
      const serviceAdapter = getProviderAdapter(state.config.serviceModel.provider);

      // Gated like the candidate call above. Grading fans out exactly as wide
      // (one per llm_grade test per sample).
      await reserveCall(state);
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
      ungraded = !!(gradingResult as any)._ungraded;

      // Bill the call BEFORE the circuit breaker can throw. The breaker's own
      // trigger call was made and charged by the provider, but the throw jumped
      // over the accrual below it — so the run's totals were short by exactly
      // one grading call, every time the breaker fired.
      accrueCost(state, state.costContext === 'holdout' ? COST_LABELS.holdoutGrading : COST_LABELS.grading, state.config.serviceModel, {
        usd: gradingResult.usd, promptTokens: gradingResult.promptTokens,
        completionTokens: gradingResult.completionTokens, calls: 1,
      });

      // Track grading parse failures for circuit breaker
      state.gradingTotal++;
      if ((gradingResult as any)._ungraded) {
        // Surface the fabricated 5.0s. The circuit breaker only fires past 8%;
        // below that the invented scores reached the report unannounced.
        state.run.ungradedTests = (state.run.ungradedTests ?? 0) + 1;
        if (nodeId) state.ungradedByNode.set(nodeId, (state.ungradedByNode.get(nodeId) ?? 0) + 1);
      }
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

      // (grading cost already accrued above, before the circuit breaker)
      
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
          // A config typo must not hand out a plausible middle score. 5.0 with
          // no `ungraded` flag counted FULLY in the quality mean, so every
          // candidate got a permanent free 5.0 indistinguishable from a
          // measurement — the free-value bug class again, this time triggered by
          // a misspelt option rather than by the candidate. Nothing was measured,
          // so nothing is credited.
          console.warn(
            `[Test] Unknown distanceMetric "${distanceMetric}" — scoring 0. Valid values are ` +
            `levenshtein, json_diff, numeric_abs.`,
          );
          score = 0;
          passed = false;
          ungraded = true;
        }
      }
    } else if (test.mode === 'json_schema') {
      const { scoreJsonSchema } = await import('./structured.js');
      const r = scoreJsonSchema(effectiveOutput, test.schema, test.id, test.expected);
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
      // A fabricated 5.0 must be machine-readable AT THE LEAF. Only the
      // run-level `ungradedTests` count existed, so results.json showed
      // `"score": 5` with no way to tell it from a judge that genuinely said
      // 5 — while report.ts told readers the leaf was the honest record.
      ...(ungraded ? { ungraded: true } : {}),
      output: effectiveOutput,
      // Put the real cause in the per-test explanation, not only in a console
      // warning the desktop hides by default. "invalid JSON: no parseable JSON
      // found" is true but blames the prompt for a token-cap setting.
      reasoning: result.truncated
        ? `[cut off at the ${maxTokens}-token cap — raise serviceModelMaxTokens] ${llmGradeReasoning ?? ''}`.trim()
        : llmGradeReasoning,
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
      setStopReason(state, 'time');
      return true;
    }
  }
  
  // Budget limit (!== undefined, not truthiness: budgetUSD 0 means "spend
  // nothing", not "no limit")
  if (config.targets.budgetUSD !== undefined) {
    if (run.totals.usd >= config.targets.budgetUSD) {
      setStopReason(state, 'budget');
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
      setStopReason(state, 'target');
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
      setStopReason(state, 'generations');
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
    // A manual Stop must abort the playoff too. finishEvaluation only drains
    // `inProgress`, and during a generation transition every node is already
    // finished — so the drain returned instantly, the run was declared
    // finished, and the playoff plus a full operator batch kept running.
    // Measured 58 further provider calls (+19.5%) served after the run
    // reported `stopReason: manual`, absent from totals, the breakdown, the
    // report, the spend ledger and the budget check.
    shouldAbort: () =>
      state.stopRequested ||
      state.status === 'stopped' ||
      (budgetCapped && state.run.totals.usd >= budget!),
  });
  if (!result) return;

  // Only let a DECISIVE playoff override fitness.
  //
  // playoffRank sorts ahead of fitness in both elite and parent selection, so
  // an unreliable judge silently broke elitism's one guarantee: measured
  // generation-best fitness DECREASING in 16 of 135 transitions with a noisy
  // judge (0 of 135 with no playoff), champion accuracy falling from 100% to
  // 45%, and the champion landing below the run's best-fitness node in 12 of
  // 15 runs. The docs recommend enabling pairwise exactly when scores cluster —
  // which is also when the judge is least reliable.
  //
  // A full point means both orders agreed; half means they disagreed and the
  // match is noise. Requiring the leader to be a clear win ahead of the
  // runner-up keeps the feature (it still overrides fitness when the judge
  // discriminates) while refusing to act on a coin flip.
  const MIN_DECISIVE_MARGIN = 1;
  const [firstId, secondId] = result.ranking;
  const margin = (result.points[firstId] ?? 0) - (result.points[secondId] ?? 0);
  const decisive = result.ranking.length < 2 || margin >= MIN_DECISIVE_MARGIN;

  if (decisive) {
    result.ranking.forEach((id, i) => {
      const node = contenders.find(n => n.id === id);
      if (node?.metrics) {
        node.metrics.playoffRank = i + 1;
        sendUpdate(runId, { type: 'node_updated', node });
      }
    });
  } else {
    console.warn(
      `[Playoff] Gen ${genIndex}: top two separated by only ${margin.toFixed(1)} point(s) — ` +
      `not decisive enough to override fitness. Ranking recorded for reference; selection stays fitness-based.`,
    );
  }
  // Record `decisive` WITH the ranking. It used to be recorded bare, so
  // selectChampion took ranking[0] from a playoff this function had just
  // declared "not decisive enough to override fitness" — the champion the user
  // takes away, and the prompt the holdout measures, came from the discarded
  // ranking while selection used fitness. Measured: a run whose report said
  // "Champion selected by pairwise playoff / Fitness 5.000" three lines under a
  // generation table reading "Best Fitness 10.000".
  state.run.playoffs = [
    ...(state.run.playoffs ?? []),
    { generation: genIndex, ranking: result.ranking, decisive },
  ];
  sendUpdate(runId, { type: 'playoff_result', generation: genIndex, ranking: result.ranking, matches: result.matches, decisive });
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
    // Say WHY there are none. "exhausted" was written unconditionally, so a
    // generation whose every node was abandoned by the cap reported
    // `exhausted` — and docs/cli.md tells agents to branch on stopReason, so a
    // budget stop read as "evolution ran out of ideas". Keep an already-set
    // reason (budget/manual/time) rather than overwriting it.
    const abandonedByBudget = state.budgetRefusals > 0;
    console.log(
      `[Evaluator] No valid performers, stopping` +
      (abandonedByBudget ? ` (budgetUSD refused ${state.budgetRefusals} call(s) this run)` : ''),
    );
    if (!state.run.stopReason) {
      setStopReason(state, abandonedByBudget ? 'budget' : 'exhausted');
    }
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
    state.run.generations, // Pass all generations for elitism
    {
      // The settled-spend gate, thrown as BudgetExhaustedError when the cap
      // is already crossed — the per-child catch carries the parent unpaid.
      reserve: () => reserveCall(state),
      // Stop as well as budget: the operator batch ran on after a manual Stop
      // for the same reason the playoff did.
      exhausted: (extraUSD = 0) =>
        budgetExhausted(state, extraUSD) || state.stopRequested || state.status === 'stopped',
      // Settle each child's spend AS IT COMPLETES. Accruing the whole batch
      // after createNextGeneration returned froze the gate for the entire
      // transition: measured 24 ungated calls and 4.6x the cap (pass 19,
      // hunter B F2). This callback replaces the post-hoc lump accrual.
      accrueChild: (cost) => {
        accrueCost(state, COST_LABELS.operators, state.config.serviceModel, {
          usd: cost.usd, promptTokens: cost.promptTokens,
          completionTokens: cost.completionTokens, calls: cost.calls,
        });
        sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
      },
    },
  );

  const newGenNodes = result.newNodes;
  // Costs were settled per child via accrueChild — do NOT accrue
  // result.costTracking again here, that would double-count the batch.
  
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

  // Resume dedupe, matching maybeRunPlayoff. A checkpoint taken between this
  // function's own persistRun and finishEvaluation's already contains a
  // COMPLETE holdout — resuming from it re-ran and re-billed the whole thing.
  const prior = state.run.holdout;
  if (prior && !prior.skipped && prior.champion && prior.seed) {
    console.log('[Evaluator] Holdout already evaluated in an earlier attempt — keeping it');
    sendUpdate(runId, { type: 'holdout_result', holdout: prior });
    return;
  }

  // Carry forward a half that was already measured. Requiring BOTH halves meant
  // a resume whose champion score had been checkpointed but whose seed pass had
  // not re-scored — and re-BILLED — the champion. Measured: 4 new requests, 2 of
  // them re-evaluating a champion whose holdout score was already on disk.
  const carried = prior && !prior.skipped ? prior : undefined;

  const holdout: NonNullable<EvaluationRun['holdout']> = {
    ...(carried?.champion ? { champion: carried.champion } : {}),
    ...(carried?.seed ? { seed: carried.seed } : {}),
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
  // A run aborted by the grading circuit breaker must not pay for a holdout
  // judged by the SAME model it just declared unusable — measured funding 2
  // holdout calls after reporting itself aborted, recording neither a champion
  // nor a seed for the money. A time limit means the same thing as a budget:
  // the ceiling the user set has been reached.
  if (state.run.stopReason === 'error' || state.run.stopReason === 'time'
      || state.run.stopReason === 'manual') {
    holdout.skipped = state.run.stopReason;
    console.warn(`[Evaluator] Run ended with '${state.run.stopReason}' — skipping holdout evaluation`);
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
  // Ungraded tests count 0 here too. This mean had NO ungraded filter while
  // calculateQualityScore argues at length that a placeholder 5.0 must never be
  // averaged in — so the holdout, the number docs/cli.md calls "the honest one:
  // it can't be overfit", was the one place still inflating them. Measured: an
  // honest judge scored the champion 1 on the unseen test, exactly like the
  // seed, and the report printed `seed 1.00 -> champion 5.00` — a +4.0
  // generalisation gain authored entirely by the candidate.
  const scoreOf = (r: TestResult) => ((r as any).ungraded ? 0 : r.score);
  const meanScore = (rs: TestResult[]) => rs.reduce((a, r) => a + scoreOf(r), 0) / rs.length;
  // Carry the flag through so results.json and the desktop can tell a
  // placeholder from a measurement instead of showing a bare `score: 5`.
  const perTest = (rs: TestResult[]) => rs.map(r => ({
    testId: r.testId,
    score: scoreOf(r),
    ...((r as any).ungraded ? { ungraded: true } : {}),
  }));

  state.costContext = 'holdout';
  try {
    // Skip the CALL, not just the assignment. Scoring it again and discarding
    // the result is what re-billed the champion half on resume.
    if (!holdout.champion) {
      const championResults = await evaluatePromptOnTests(champion.prompt, champion.params, state.holdoutTests, state, runId);
      holdout.champion = { score: meanScore(championResults), perTest: perTest(championResults) };
    }
    // A Stop arriving mid-holdout used to keep paying: finishEvaluation had
    // already latched, so stopEvaluation returned immediately from the latch
    // while the remaining holdout calls ran on. Re-check between the two halves.
    // NOT an early `return` — that skipped the tail sendUpdate+persistRun, so
    // the champion half was billed, the DB (eventually) said skipped:'manual',
    // and the live UI showed NOTHING: indistinguishable from "no holdout
    // configured" while money had just been spent on half of one (pass 19,
    // hunter C F2).
    if (state.stopRequested) {
      console.warn('[Evaluator] Stop requested during holdout — skipping the seed baseline');
      holdout.skipped = 'manual';
    } else {
      if (!holdout.seed) {
        const seedResults = await evaluatePromptOnTests(state.config.population.seedPrompt, champion.params, state.holdoutTests, state, runId);
        holdout.seed = { score: meanScore(seedResults), perTest: perTest(seedResults) };
      }
      console.log(`[Evaluator] Generalization (unseen tests): seed ${holdout.seed.score.toFixed(2)} → champion ${holdout.champion.score.toFixed(2)}`);
    }
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

  // Every terminal run must say WHY it ended. The loop can drain with no reason
  // set (e.g. a generation that produced no queueable work), and results.json
  // then simply had no stopReason at all — while docs/cli.md lists seven values
  // and tells agents to branch on it.
  if (!state.run.stopReason) {
    console.warn('[Evaluator] Loop drained with no stop reason recorded — reporting "exhausted"');
    setStopReason(state, 'exhausted');
  }

  // The final generation never reaches moveToNextGeneration — run its playoff here
  // so the champion (and the holdout below) reflect the last generation's ranking.
  // Both are billable: a user who pressed Stop wants spending to STOP, not to
  // fund a playoff plus a holdout pass afterwards.
  // 'error' belongs here too. The grading circuit breaker aborts a run whose
  // judge is broken, and the playoff and holdout are judged by that SAME model
  // — so a run that had already reported itself aborted went on to fund 12
  // playoff calls and 2 holdout calls (19% of the run) using the judge it had
  // just declared unusable, and recorded neither a champion nor a seed for the
  // money spent. 'budget' and 'time' likewise mean the user set a ceiling that
  // has been reached; spending past it to compute a nicety is not what either
  // option asks for.
  // 'budget' here is REDUNDANT and kept for intent: reserveCall is a
  // settled-spend gate, so this reason already implies totals >= budgetUSD, and
  // the playoff and holdout each have their own budget gate that would fire.
  // Verified by mutation — removing it changes no observable behaviour.
  const SKIP_EXTRA_SPEND = new Set(['manual', 'error', 'budget', 'time']);
  if (state.run.stopReason && SKIP_EXTRA_SPEND.has(state.run.stopReason)) {
    console.log(
      `[Evaluator] Stop reason '${state.run.stopReason}' — skipping the playoff to stop spending`,
    );
  } else {
    await maybeRunPlayoff(runId, state);
  }
  // The holdout still RUNS, because it has its own gate that records why it was
  // skipped. Omitting the call entirely lost that marker and the report then
  // said nothing at all about generalisation.
  await runHoldoutEvaluation(runId, state);
  console.log(`[Evaluator] Finishing evaluation, reason=${state.run.stopReason}`);
  
  // The budget can decide a run's outcome without settled spend ever reaching
  // the cap: reservations refuse work while totals sit below it. Reporting
  // "generations" there told an agent branching on stopReason (as docs/cli.md
  // instructs) that a crippled run was a clean, cheap success.
  if (
    state.budgetRefusals > 0 &&
    (state.run.stopReason === 'generations' || state.run.stopReason === 'exhausted')
  ) {
    console.warn(
      `[Evaluator] budgetUSD refused ${state.budgetRefusals} call(s); ` +
      `$${state.run.totals.usd.toFixed(4)} of $${state.config.targets.budgetUSD} settled. ` +
      `Reporting stopReason "budget" — the cap, not ${state.run.stopReason}, determined this outcome.`,
    );
    setStopReason(state, 'budget');
  }

  state.status = 'stopped';
  state.run.status = 'finished';
  state.run.finishedAt = Date.now();

  state.run.ungradedTests = reconcileUngradedCount(state.run, state.ungradedByNode);
  persistRun(state);

  // The checkpoint is now authoritative and the run cannot be resumed, so the
  // sidecar has nothing left to recover. Clearing it AFTER the durable write
  // means a crash in between simply leaves a sidecar that agrees with the
  // checkpoint — the resume path takes the larger of the two either way.
  try { clearSpend(getDatabase().dbPath, state.run.id); } catch { /* best effort */ }

  sendUpdate(runId, {
    type: 'cost_breakdown',
    breakdown: state.run.costBreakdown,
    estimate: state.run.estimate,
    ungradedTests: state.run.ungradedTests,
    // Pass 19 (hunter C F1): this field was persisted but never crossed IPC,
    // so the desktop's "holdout share rounded to zero" warning could only ever
    // appear after an app restart re-read run_json — never in the session
    // where the user could act on it. This terminal event is its carriage.
    ...(state.run.holdoutSkippedReason ? { holdoutSkippedReason: state.run.holdoutSkippedReason } : {}),
  });

  // Send final updates
  if (state.run.stopReason) {
    sendUpdate(runId, { type: 'stop', reason: state.run.stopReason });
  }
  sendUpdate(runId, { type: 'totals', totals: state.run.totals, cacheHits: state.run.cacheHits });
  sendUpdate(runId, { type: 'status', status: 'finished' });
  
  // Remove from active evaluations
  activeEvaluations.delete(runId);

  // Restore the ceiling to what the REMAINING runs asked for. The max-across-
  // live-runs rule was only applied on start, never on finish, so a short
  // parallelLimit-16 run permanently raised a long parallelLimit-1 run's
  // ceiling — silently removing the rate-limit protection the user chose for
  // the rest of its life.
  const stillLive = [...activeEvaluations.values()].map(s => s.config.parallelLimit || 1);
  if (stillLive.length > 0) {
    const restored = Math.max(...stillLive);
    initGlobalSemaphore(restored);
    console.log(`[Evaluator] Global API limit restored to ${restored} (${stillLive.length} run(s) still live)`);
  }

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
  // params.seed IS part of the key. It was excluded on the reasoning that
  // children inherit their parent's seed so the components co-vary — but that
  // is false for generation 0, where createAutoShellNodes derives a DIFFERENT
  // seed per sibling while they all start from the same seed prompt. Sibling
  // lineages then converge on identical prompts with different seeds, and one
  // node was served another's results: measured 2.6% of finished nodes
  // reporting a score that did not match their own seed.
  //
  // ...but only where the seed can actually reach the provider. An adapter
  // that accepts `seed` and drops it (Anthropic's Messages API has no such
  // parameter) makes identical prompts look like distinct work: measured 38
  // calls / 4 cache hits seeded versus 30 / 6 unseeded on the same config.
  let seedPart = `${node.params.seed ?? 'none'}`;
  try {
    if (getProviderAdapter(node.params.model.provider)?.supportsSeed === false) {
      seedPart = 'ignored';
    }
  } catch { /* unknown provider: keep the seed in the key, the safe direction */ }

  return createHash('sha256')
    .update(
      `${node.prompt}|${node.params.model.provider}/${node.params.model.model}` +
      `|${node.params.temperature}|${seedPart}` +
      `|${state.promptMode}|${state.samplesPerTest}|${testSetSig}`,
    )
    .digest('hex');
}

/**
 * True when the run has already spent its budget. Checked immediately before
 * every billable call — `shouldStop` alone is only consulted at node
 * boundaries, so a node with N tests × M samples could fire N×M×2 more calls
 * (times parallelLimit) after the cap was already reached.
 */
/**
 * Identify an image by its magic bytes, or return null.
 *
 * Trusting the file extension meant a config could name ANY file — a key
 * store, an SSH key — and the engine would base64 it, label it image/png and
 * upload it to the model provider.
 */
function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function budgetExhausted(state: EvaluationState, extraUSD = 0): boolean {
  const budget = state.config.targets.budgetUSD;
  // `extraUSD`: spend a multi-call operator has already billed but not yet
  // settled into totals — without it, an operator's own retries can never
  // trip the gate they are being checked against (pass 19, hunter B F1).
  return budget !== undefined && state.run.totals.usd + extraUSD >= budget;
}

/**
 * Completion length a reservation assumes before this run has measured one.
 *
 * NOT `maxTokens`. Reserving the token cap looked like the rigorous choice —
 * a true upper bound makes budgetUSD a hard bound — but the cap defaults to
 * 20000 while real completions are 100-1000 tokens, so every in-flight call
 * held 20-200x its true cost, `parallelLimit` at a time. Measured on a run
 * whose true cost was $0.3880: at a $1.00 budget (2.6x the real cost) it made
 * 47 of 194 calls, destroyed 5 of 8 generation-0 nodes, carried 24 of 32
 * children forward unmutated — and reported stopReason "generations" with
 * 9.4% of the budget spent. The cap became a floor on what you had to budget:
 * parallelLimit x 2 x maxTokens/1000 x completionPrice, regardless of the run.
 *
 */
/** The settled-spend budget gate: throws BudgetExhaustedError once the cap is crossed. */
async function reserveCall(state: EvaluationState): Promise<void> {
  const budget = state.config.targets.budgetUSD;
  if (budget === undefined) return;
  // REVERTED to a settled-spend gate. Reserving a predicted per-call cost
  // was tried three times and failed a different way each time:
  //   - reserving serviceModelMaxTokens strangled runs at 2.6x their true
  //     cost while reporting stopReason "generations";
  //   - reserving a 1024-token assumption still overshot 19.2x at
  //     parallelLimit 8 (overshoot scales with real completion length) AND
  //     still returned NOTHING below ~1.25x true cost, because one refusal
  //     aborts a whole node via Promise.all and the cascade takes the
  //     generation.
  // A run that spends money and produces nothing is worse than a run that
  // overshoots, so this returns to the known, bounded behaviour: the cap is
  // checked against SETTLED spend at every call site. Overshoot is
  // parallelLimit x testCount x samplesPerTest calls' worth, which
  // docs/cli.md states plainly. Do not replace this with a prediction
  // without measuring BOTH failure directions first.
  if (state.run.totals.usd >= budget) {
    state.budgetRefusals++;
    throw new BudgetExhaustedError();
  }
}

/**
 * Set the stop reason, refusing to DOWNGRADE an error.
 *
 * `error` was set by the grading circuit breaker and then overwritten before
 * finishEvaluation read it: two unconditional writers run during the
 * `while (state.inProgress.size > 0)` drain — shouldStop() and processNode's
 * BudgetExhaustedError branch. Measured with a budget tuned to land in that
 * window: a run whose judge failed to parse 20/20, every score fabricated,
 * reported `stopReason: budget` and exited 0. docs/cli.md tells agents to
 * branch on stopReason, and packages/cli/src/index.ts exits 1 on `error`
 * precisely so a breaker-aborted run is not mistaken for an ordinary stop.
 *
 * `error` and `manual` are decisions already taken; everything else is a
 * condition that merely became true later.
 */
const STICKY_STOP_REASONS = new Set(['error', 'manual']);
/**
 * The run's ungraded-test count, reconciled from every source.
 *
 * Exported so a test can drive the REAL function: the first test written for
 * this pasted a copy of it into the test file and asserted against the copy,
 * so reverting the whole fix left the suite green.
 */
export function reconcileUngradedCount(
  run: EvaluationRun,
  ungradedByNode: ReadonlyMap<UUID, number> = new Map(),
): number {
  // The SWEEP is authoritative, plus the tally for nodes that never produced a
  // `tests` array. Two wrong versions preceded this:
  //
  //   assign(sweep)  - right unit, resume-safe, but ERASED a count earned by a
  //                    failed node whose siblings had already recorded failures.
  //   max(counter, sweep) - fixed that and broke both others: the counter counts
  //                    SAMPLES while the sweep counts TEST RESULTS, so at
  //                    samplesPerTest 3 one failure reported 3; and a resume
  //                    re-evaluates replayed nodes, inflating the counter again
  //                    on every restart.
  //
  // Counting failed nodes explicitly keeps the sweep's unit AND stays correct
  // across a resume, because the tally is per-process and only consulted for
  // nodes with no leaves of their own.
  const holdoutLeaves = [run.holdout?.seed, run.holdout?.champion]
    .flatMap(half => (half?.perTest ?? []) as any[])
    .filter(row => row?.ungraded).length;
  let total = holdoutLeaves;
  for (const node of run.generations.flat()) {
    const leaves = (node.tests ?? []).filter(t => (t as any).ungraded).length;
    total += node.tests ? leaves : ((node as any).ungradedTests ?? ungradedByNode.get(node.id) ?? 0);
  }
  return total;
}

export function setStopReason(state: EvaluationState, reason: NonNullable<EvaluationRun['stopReason']>): void {
  const current = state.run.stopReason;
  if (current && STICKY_STOP_REASONS.has(current) && !STICKY_STOP_REASONS.has(reason)) {
    console.warn(`[Evaluator] Keeping stopReason '${current}' — refusing to downgrade it to '${reason}'.`);
    return;
  }
  state.run.stopReason = reason;
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
  // Warn once when a CATALOGUED model reports zero spend for real tokens.
  //
  // Budget enforcement runs off totals.usd, which is whatever the adapter
  // self-reported. BaseProviderAdapter computes it from the catalog, but a
  // plain-object plugin adapter (the shape docs/plugins.md documents) returns
  // its own — and one returning `usd: 0` spends without limit while
  // `budgetUSD` never trips. The pricingUnknown preflight cannot see this: it
  // inspects the catalog, and the catalog is fine.
  if (c.usd === 0 && (c.promptTokens > 0 || c.completionTokens > 0) && !state.warnedZeroCostModels.has(`${model.provider}/${model.model}`)) {
    state.warnedZeroCostModels.add(`${model.provider}/${model.model}`);
    console.warn(
      `[Evaluator] ${model.provider}/${model.model} reported $0 for a call that used ` +
      `${c.promptTokens + c.completionTokens} tokens. If that is not a genuinely free model, budgetUSD ` +
      `cannot be enforced for it — a provider adapter must return a real "usd" value.`,
    );
  }

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

  // Durable, on EVERY accrual. The checkpoint cannot do this — it serialises
  // the whole run — so spend between checkpoints used to vanish on a crash and
  // each resume re-armed the entire budget. This sidecar is ~1 KB regardless of
  // run size. See spendledger.ts.
  try {
    recordSpend(getDatabase().dbPath, {
      runId: state.run.id,
      totals: { ...state.run.totals },
      costBreakdown: state.run.costBreakdown,
      at: Date.now(),
    });
  } catch { /* advisory only — never fail a run over accounting */ }
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

/**
 * Stable fingerprint of the system prompts in force right now.
 *
 * `systemPrompts` are HOST-injected, not part of the stored config — the CLI
 * takes them from the `--config` file. `--config` is optional on resume, so
 * resuming without it silently swapped the grading rubric back to the built-in
 * default mid-run: one results.json whose early nodes were scored 10/10 by the
 * custom rubric and whose later nodes were scored 1/10 by another, with
 * selection comparing the two as if they meant the same thing.
 */
function graderFingerprint(): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  };
  let serialized: string;
  try {
    serialized = stable(store.get('systemPrompts', null));
  } catch {
    return 'unavailable';
  }
  // FNV-1a. Not security — this only has to notice that the rubric changed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Paused-time total for a starting run, crediting process downtime on resume.
 *
 * Pure: the caller assigns the result to BOTH state.totalPausedMs and
 * state.run.totalPausedMs. Mutating `run` from in here looked equivalent but was
 * not — state.run is a shallow copy made before this ran, and persistRun
 * serialises that copy, so the credit never reached disk.
 */
function resumeAdjustedPausedMs(run: EvaluationRun, isResume: boolean): number {
  return (run.totalPausedMs ?? 0) + (isResume ? downtimeSinceCheckpoint(run) : 0);
}

/**
 * Checkpoint the run.
 *
 * `durable` forces the write to disk immediately. Use it where losing the
 * checkpoint actually costs something — a generation boundary, a pause, the
 * end of the run. The per-NODE checkpoint passes false and rides the wrapper's
 * adaptive debounce instead: forcing an fsync there meant one whole-file export
 * per node, and because that export scales with total database size, a 72-node
 * run against a 25MB database spent ~3.1s blocked and wrote ~1.8GB. The
 * in-memory row is updated either way, so a crash loses at most the debounce
 * window rather than a whole generation.
 */
/**
 * Fraction of wall-clock time the per-node checkpoint is allowed to consume.
 * 1/20 = 5%. Checkpoint cost scales with the size of the whole run, so a fixed
 * "every node" policy is O(nodes x runSize) — quadratic.
 */
const CHECKPOINT_DUTY_DIVISOR = 20;
const MAX_NODE_CHECKPOINT_GAP_MS = 15_000;

/**
 * Checkpoint after a node, but not more often than the checkpoint can afford.
 *
 * `persistRun` does `JSON.stringify(state.run)` plus an UPDATE carrying that
 * whole string, and `state.run` holds every node of every generation with every
 * test output. Running it once per node therefore costs O(nodes x runSize) —
 * measured on a 30-node x 20-generation run with 20 KB outputs, generation 19
 * took 33.9 s of which 31.3 s (92%) was checkpointing, against 1.5 s for
 * generation 0. Totals: 42.9 GB of JSON produced, 214 s inside sql.js, single
 * longest synchronous block 2.9 s — and in Electron every one of those is a
 * frozen main process.
 *
 * Self-tuning: measure how long a checkpoint takes and require that much x20 of
 * elapsed time before the next one. Cheap runs (a few ms per checkpoint) still
 * checkpoint on effectively every node; expensive ones back off. A crash loses
 * at most the gap, which is the same class of loss the DB's save debounce
 * already accepts — and generation boundaries, pauses and the final write all
 * call persistRun directly and are never throttled.
 */
export function nodeCheckpointDue(now: number, lastAt: number, lastCostMs: number): boolean {
  const required = Math.min(MAX_NODE_CHECKPOINT_GAP_MS, lastCostMs * CHECKPOINT_DUTY_DIVISOR);
  return now - lastAt >= required;
}

function maybeCheckpointNode(state: EvaluationState): void {
  if (!nodeCheckpointDue(Date.now(), state.lastNodeCheckpointAt, state.lastCheckpointCostMs)) return;

  const startedAt = Date.now();
  persistRun(state, false); // ride the DB's adaptive debounce, not an fsync each time
  state.lastCheckpointCostMs = Date.now() - startedAt;
  state.lastNodeCheckpointAt = Date.now();
}

function persistRun(state: EvaluationState, durable = true): void {
  try {
    state.run.lastCheckpointAt = Date.now();
    const db = getDatabase();
    db.prepare(`
      UPDATE evaluation_runs
      SET run_json = ?, finished_at = ?, stop_reason = ?
      WHERE id = ?
    `).run(
      JSON.stringify(state.run),
      // These columns exist in the schema and were written only by import and
      // the dev seeder — real runs left them NULL forever while the same facts
      // sat inside run_json. Any future SQL consumer would have read that as
      // "no run ever finished".
      state.run.finishedAt ?? null,
      state.run.stopReason ?? null,
      state.run.id,
    );
    // Flush now instead of 50ms from now. docs/cli.md promises "if the process
    // dies, nothing is lost" — with only the debounced save, a hard crash
    // inside that window lost the checkpoint the resume path depends on.
    //
    // flush() reports whether the data actually reached disk: on Windows the
    // rename loses to any process holding the file open, and a silently
    // dropped FINAL checkpoint makes a completed run reappear as interrupted,
    // so --resume pays for it a second time. A retry is already scheduled;
    // say so rather than reporting success.
    if (durable && !db.flush()) {
      console.warn(
        `[Evaluator] Checkpoint for ${state.run.id.slice(0, 8)} is not on disk yet — a retry is scheduled. ` +
        `If the process dies before it succeeds, this generation's progress will be replayed on resume.`,
      );
    }
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
/**
 * Ids of runs still working. The desktop needs this to warn before quitting:
 * closing the window mid-run silently ended it, and calls already in flight are
 * paid for and unrecoverable (the spend sidecar only recovers SETTLED spend).
 */
export function runningEvaluationIds(): UUID[] {
  return [...activeEvaluations.entries()]
    .filter(([, st]) => st.status === 'running')
    .map(([id]) => id);
}

export function stopEvaluation(runId: UUID): void {
  const state = activeEvaluations.get(runId);
  if (state) {
    state.status = 'stopped';
    state.stopRequested = true;
    // Do NOT rewrite a stopReason that finishEvaluation already settled. Once
    // the run has latched into finishing, its true reason is known ('budget',
    // 'generations', …) — overwriting it with 'manual' made the persisted
    // reason a lie, and docs/cli.md tells agents to branch on that field.
    if (!state.finishing) {
      setStopReason(state, 'manual');
    }
    // stopEvaluation is a sync host API — fire and forget the async finish
    finishEvaluation(runId, state).catch(err => console.error('[Evaluator] finish failed:', err));
  }
}

