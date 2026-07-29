/**
 * CLI Engine Adapter
 *
 * Hooks into the evaluation engine by:
 * 1. Replacing the store module so providers can resolve API keys
 * 2. Persisting config + run into DB (matching IPC handler behavior)
 * 3. Setting the sendUpdate callback to route events to CLI display
 * 4. Collecting all node/generation/test data for rich output
 * 5. Running startEvaluation and waiting for completion
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  EvaluationConfig,
  EvaluationRun,
  UUID,
  CandidateNode,
} from '@promptengine/core';

type HoldoutResult = NonNullable<EvaluationRun['holdout']>;
import { createCliStore } from './store.js';
import { setStore } from '@promptengine/core';
import * as display from './display.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvolutionResultNode {
  id: UUID;
  status: string;
  prompt: string;
  params: CandidateNode['params'];
  changeLog: CandidateNode['changeLog'];
  lineageParents: UUID[];
  metrics: CandidateNode['metrics'] | null;
  tests: CandidateNode['tests'] | null;
  error?: string;
}

export interface EvolutionResultGeneration {
  generation: number;
  nodes: EvolutionResultNode[];
}

export interface EvolutionResult {
  runId: UUID;
  configId: UUID;
  configName: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  stopReason?: string;
  error?: string;
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  cacheHits: number;
  best: {
    prompt: string;
    fitness: number;
    quality: number;
    model: string;
    nodeId: UUID;
    generation: number;
  } | null;
  holdout?: HoldoutResult;
  seed?: number;
  playoffs?: Array<{ generation: number; ranking: string[] }>;
  costBreakdown?: EvaluationRun['costBreakdown'];
  estimate?: EvaluationRun['estimate'];
  generations: EvolutionResultGeneration[];
}

// ---------------------------------------------------------------------------
// Internal collector — captures all engine events
// ---------------------------------------------------------------------------

interface RunCollector {
  generations: Map<number, Map<UUID, CandidateNode>>;
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  cacheHits: number;
  bestNode: CandidateNode | null;
  error: string | null;
  stopReason: string | null;
  holdout: HoldoutResult | null;
  playoffs: Array<{ generation: number; ranking: string[] }>;
  costBreakdown: EvaluationRun['costBreakdown'] | null;
  estimate: EvaluationRun['estimate'] | null;
}

function createCollector(): RunCollector {
  return {
    generations: new Map(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    cacheHits: 0,
    bestNode: null,
    error: null,
    stopReason: null,
    holdout: null,
    playoffs: [],
    costBreakdown: null,
    estimate: null,
  };
}

function cloneNode(node: CandidateNode): CandidateNode {
  return structuredClone(node);
}

// ---------------------------------------------------------------------------
// Store shim
// ---------------------------------------------------------------------------

/**
 * Install the CLI store shim so providers resolve API keys via
 * env vars > config > electron-store fallback.
 * Must be called before startEvaluation.
 */
export function installStoreShim(cliConfigKeys?: Record<string, string>, systemPrompts?: Record<string, any>): void {
  const cliStore = createCliStore(cliConfigKeys, systemPrompts);
  setStore(cliStore);
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

function buildResult(
  config: EvaluationConfig,
  run: EvaluationRun,
  collector: RunCollector,
  finishedAt: number,
): EvolutionResult {
  // Sort generations by number
  const sortedGens = [...collector.generations.entries()].sort((a, b) => a[0] - b[0]);

  const generations: EvolutionResultGeneration[] = sortedGens.map(([gen, nodesMap]) => ({
    generation: gen,
    nodes: [...nodesMap.values()].map((n) => ({
      id: n.id,
      status: n.status,
      prompt: n.prompt,
      params: n.params,
      changeLog: n.changeLog,
      lineageParents: n.lineageParents,
      metrics: n.metrics ?? null,
      tests: n.tests ?? null,
      error: n.error,
    })),
  }));

  // Champion: latest playoff winner when playoffs ran, else best-by-fitness
  let best = collector.bestNode;
  const lastPlayoff = collector.playoffs[collector.playoffs.length - 1];
  if (lastPlayoff) {
    for (const nodesMap of collector.generations.values()) {
      const winner = nodesMap.get(lastPlayoff.ranking[0]);
      if (winner) { best = winner; break; }
    }
  }

  return {
    runId: run.id,
    configId: config.id,
    configName: config.name,
    startedAt: run.startedAt,
    finishedAt,
    durationMs: finishedAt - run.startedAt,
    stopReason: collector.stopReason ?? undefined,
    error: collector.error ?? undefined,
    totals: { ...collector.totals },
    cacheHits: collector.cacheHits,
    holdout: collector.holdout ?? undefined,
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(collector.playoffs.length ? { playoffs: collector.playoffs } : {}),
    ...(collector.costBreakdown ? { costBreakdown: collector.costBreakdown } : {}),
    ...(collector.estimate ? { estimate: collector.estimate } : {}),
    best: best
      ? {
          prompt: best.prompt,
          fitness: best.metrics?.fitness ?? 0,
          quality: best.metrics?.quality ?? 0,
          model: `${best.params.model.provider}/${best.params.model.model}`,
          nodeId: best.id,
          generation: best.generation,
        }
      : null,
    generations,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface RunEvolutionOptions {
  onRunId?: (id: string) => void;
  existingRun?: EvaluationRun; // resume: checkpointed run loaded from the DB (skips inserts)
}

/**
 * Run a full evolution from the CLI.
 * Persists config + run to DB, collects all data, returns rich result.
 */
export async function runEvolution(
  config: EvaluationConfig,
  options?: RunEvolutionOptions,
): Promise<EvolutionResult> {
  // Reset display state from any previous run
  display.resetState();

  const collector = createCollector();

  // Set up the sendUpdate hook before importing the evaluator
  const { setSendUpdate, startEvaluation } = await import(
    '@promptengine/core'
  );

  const runId: UUID = options?.existingRun?.id ?? uuidv4();
  options?.onRunId?.(runId);

  let resolveFinished: (() => void) | null = null;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  // Route engine events to collector + CLI display
  setSendUpdate((_runId: UUID, data: any) => {
    switch (data.type) {
      case 'node_created': {
        const node = cloneNode(data.node as CandidateNode);
        let genMap = collector.generations.get(node.generation);
        if (!genMap) {
          genMap = new Map();
          collector.generations.set(node.generation, genMap);
        }
        genMap.set(node.id, node);
        display.onNodeCreated(data.node as CandidateNode);
        break;
      }
      case 'node_updated': {
        const node = cloneNode(data.node as CandidateNode);
        let genMap = collector.generations.get(node.generation);
        if (!genMap) {
          genMap = new Map();
          collector.generations.set(node.generation, genMap);
        }
        genMap.set(node.id, node);

        // Track best node
        if (
          node.metrics?.fitness !== undefined &&
          (collector.bestNode === null ||
            node.metrics.fitness > (collector.bestNode.metrics?.fitness ?? 0))
        ) {
          collector.bestNode = node;
        }

        display.onNodeUpdated(data.node as CandidateNode);
        break;
      }
      case 'generation_created': {
        const nodes = (data.nodes as CandidateNode[]).map(cloneNode);
        let genMap = collector.generations.get(data.generation);
        if (!genMap) {
          genMap = new Map();
          collector.generations.set(data.generation, genMap);
        }
        for (const n of nodes) {
          genMap.set(n.id, n);
        }
        display.onGenerationCreated(data.generation, data.nodes);
        break;
      }
      case 'totals':
        collector.totals = { ...data.totals };
        collector.cacheHits = data.cacheHits ?? collector.cacheHits;
        display.onTotals(data.totals, data.cacheHits);
        break;
      case 'population_ready':
        display.onPopulationReady();
        break;
      case 'status':
        if (data.status === 'finished') {
          display.onFinished();
          resolveFinished?.();
        }
        break;
      case 'stop':
        collector.stopReason = data.reason ?? 'unknown';
        break;
      case 'holdout_result':
        collector.holdout = data.holdout;
        break;
      case 'playoff_result':
        collector.playoffs.push({ generation: data.generation, ranking: data.ranking });
        break;
      case 'cost_breakdown':
        collector.costBreakdown = data.breakdown ?? null;
        collector.estimate = data.estimate ?? null;
        break;
      case 'error':
        collector.error = data.message;
        display.onError(data.message);
        // Note: the evaluator only sends 'error' for non-fatal background mutation
        // failures. The evaluation loop continues and will still send 'finished'.
        // Do NOT reject here — that would return an incomplete result.
        break;
    }
  });

  // Create (or reuse) the run object
  const run: EvaluationRun = options?.existingRun ?? {
    id: runId,
    configId: config.id,
    startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [],
    cacheHits: 0,
    version: '1.0',
  };

  if (!options?.existingRun) {
    // Persist config + run to DB (matching electron/ipc/handlers.ts behavior)
    const { getDatabase } = await import('@promptengine/core');
    const db = getDatabase();

    // Retry loop for config INSERT — handles rare UUID collision (matches handlers.ts)
    let configId = config.id;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        db.prepare(
          'INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)',
        ).run(configId, config.name, JSON.stringify({ ...config, id: configId }), Date.now());
        break;
      } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT' && attempt < 9) {
          configId = uuidv4();
        } else {
          throw err;
        }
      }
    }
    config.id = configId;
    run.configId = configId;

    db.prepare(
      'INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)',
    ).run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);

    process.stderr.write(`Starting evolution: "${config.name}"\n`);
    // Full id up front: if this process dies, the log holds the --resume handle
    process.stderr.write(`Run ID: ${run.id}\n`);
    process.stderr.write(
      `Models: ${config.enabledModels.map((m) => `${m.provider}/${m.model}`).join(', ')}\n`,
    );
    process.stderr.write(
      `Population: ${config.population.initialSize} | Generations: ${config.targets.maxGenerations ?? 'unlimited'}\n`,
    );
    if (config.targets.budgetUSD)
      process.stderr.write(`Budget: $${config.targets.budgetUSD}\n`);
    try {
      const { estimateRunCost, getModelCost } = await import('@promptengine/core');
      const est = await estimateRunCost(config, getModelCost);
      const scope = est.perGeneration ? ' per generation' : '';
      process.stderr.write(`Estimated cost${scope}: $${est.low.toFixed(4)} – $${est.high.toFixed(4)} (~${est.calls} calls)\n`);
      for (const w of est.warnings) process.stderr.write(`  note: ${w}\n`);
      // Stamp the preflight snapshot on the run: the report compares it to actuals
      run.estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };
    } catch (err: any) {
      process.stderr.write(`Cost estimate unavailable: ${err.message}\n`);
    }
    process.stderr.write('\n');
  } else {
    const finishedCount = run.generations.flat().filter((n) => n.status === 'finished').length;
    process.stderr.write(
      `Resuming run ${run.id.slice(0, 8)} from generation ${run.generations.length - 1} (${finishedCount} finished nodes, $${run.totals.usd.toFixed(4)} already spent)\n\n`,
    );
  }

  // Start the evaluation — catch synchronous setup errors
  try {
    await startEvaluation(runId, config, run);
  } catch (err: any) {
    const finishedAt = Date.now();
    collector.error = err.message ?? String(err);
    display.onError(collector.error!);
    return buildResult(config, run, collector, finishedAt);
  }

  // Wait for completion (resolves on 'finished' status)
  await finishedPromise;

  const finishedAt = Date.now();
  const result = buildResult(config, run, collector, finishedAt);

  if (result.holdout?.seed && result.holdout?.champion) {
    process.stderr.write(`Generalization (unseen tests): seed ${result.holdout.seed.score.toFixed(2)} → champion ${result.holdout.champion.score.toFixed(2)}\n`);
  }

  // Write JSON result to stdout for piping
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return result;
}
