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
} from '@voxor/lineage-core';

type HoldoutResult = NonNullable<EvaluationRun['holdout']>;
import { createCliStore } from './store.js';
import { setStore, selectChampion, readSpend, getDatabase, paretoFront } from '@voxor/lineage-core';
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
  /** Wall-clock from startedAt. On a resumed run this includes the downtime. */
  durationMs: number;
  /** Time this process actually spent working — the number to quote on a resume. */
  activeDurationMs: number;
  stopReason?: string;
  error?: string;
  /** id → name/mode for every configured test, so tests[].testId resolves from the output alone. */
  testSet: Array<{ id: UUID; name: string; mode: string; holdout: boolean }>;
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  cacheHits: number;
  ungradedTests?: number;
  best: {
    prompt: string;
    fitness: number;
    quality: number;
    model: string;
    nodeId: UUID;
    generation: number;
  } | null;
  holdout?: HoldoutResult;
  /**
   * Candidates no other candidate beat outright — at least as good on every
   * measured dimension and strictly better on one. Fitness is a weighted sum,
   * which cannot reach concave regions of the trade-off surface, so this says
   * what the weighting passed over. One entry means the champion dominated
   * everything and the scalarization cost nothing.
   */
  paretoFront?: Array<{ nodeId: UUID; generation: number; metrics: Record<string, number> }>;
  seed?: number;
  playoffs?: Array<{ generation: number; ranking: string[]; decisive?: boolean }>;
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
  /** Test results scored 5.0 because the judge reply was unparseable. */
  ungradedTests: number;
  bestNode: CandidateNode | null;
  error: string | null;
  stopReason: string | null;
  holdout: HoldoutResult | null;
  /**
   * `decisive` is load-bearing, not decoration: a non-decisive playoff is one
   * the engine explicitly refused to act on, and dropping the flag published a
   * ranking that reads as "the generation's best" but is a coin flip.
   */
  playoffs: Array<{ generation: number; ranking: string[]; decisive?: boolean }>;
  costBreakdown: EvaluationRun['costBreakdown'] | null;
  estimate: EvaluationRun['estimate'] | null;
}

function createCollector(): RunCollector {
  return {
    generations: new Map(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    cacheHits: 0,
    ungradedTests: 0,
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
  // When this process started work. Differs from run.startedAt on a resume,
  // where the wall-clock span would otherwise report an overnight gap as
  // "Duration: 8h 40m" for ten minutes of actual work.
  processStartedAt: number,
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

  // Non-dominated set across every scored candidate in the run.
  const allScored = generations.flatMap(g =>
    g.nodes.filter(n => n.status === 'finished' && n.metrics)
      .map(n => ({ id: n.id, generation: g.generation, metrics: n.metrics as any })));
  const paretoNodes = paretoFront(allScored).map(n => ({
    nodeId: n.id as UUID,
    generation: (n as any).generation as number,
    metrics: Object.fromEntries(
      Object.entries(n.metrics as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number'),
    ) as Record<string, number>,
  }));

  // Champion: same rule the engine's holdout pass uses — a playoff winner only
  // counts when its playoff covers the newest evaluated generation.
  const finishedNodes = sortedGens.flatMap(([gen, nodesMap]) =>
    [...nodesMap.values()]
      .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
      .map(n => ({ node: n, generation: gen })),
  );
  const choice = selectChampion(
    finishedNodes.map(f => ({ id: f.node.id, generation: f.generation, metrics: f.node.metrics, node: f.node })),
    collector.playoffs,
    entry => entry.generation,
  );
  const best = choice.champion?.node ?? collector.bestNode;
  if (choice.staleplayoffIgnored) {
    console.warn('[CLI] The last pairwise playoff predates the newest evaluated generation — ranking by fitness instead');
  }

  return {
    runId: run.id,
    configId: config.id,
    configName: config.name,
    startedAt: run.startedAt,
    finishedAt,
    durationMs: finishedAt - run.startedAt,
    activeDurationMs: finishedAt - processStartedAt,
    stopReason: collector.stopReason ?? undefined,
    error: collector.error ?? undefined,
    testSet: config.testSet.map(t => ({
      id: t.id,
      name: t.name ?? '',
      mode: t.mode ?? 'llm_grade',
      holdout: t.holdout === true,
    })),
    totals: { ...collector.totals },
    cacheHits: collector.cacheHits,
    ungradedTests: collector.ungradedTests,
    holdout: collector.holdout ?? undefined,
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(collector.playoffs.length ? { playoffs: collector.playoffs } : {}),
    ...(collector.costBreakdown ? { costBreakdown: collector.costBreakdown } : {}),
    ...(collector.estimate ? { estimate: collector.estimate } : {}),
    ...(paretoNodes.length ? { paretoFront: paretoNodes } : {}),
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
  /** Suppress the stdout copy of the result — set when --output writes it to a file. */
  suppressStdout?: boolean;
}

/**
 * Run a full evolution from the CLI.
 * Persists config + run to DB, collects all data, returns rich result.
 */
/**
 * The larger of the checkpoint total and the durable spend sidecar.
 *
 * The checkpoint is written periodically; the sidecar records every settled
 * call. After a crash the sidecar is the correct, larger figure, and the engine
 * already adopts it — only the banner still quoted the checkpoint.
 */
function resumeSpend(run: any): number {
  const checkpoint = run?.totals?.usd ?? 0;
  try {
    return Math.max(checkpoint, readSpend(getDatabase().dbPath, run.id)?.totals?.usd ?? 0);
  } catch {
    return checkpoint;
  }
}

export async function runEvolution(
  config: EvaluationConfig,
  options?: RunEvolutionOptions,
): Promise<EvolutionResult> {
  // Reset display state from any previous run
  display.resetState();

  const processStartedAt = Date.now();
  const collector = createCollector();

  // Set up the sendUpdate hook before importing the evaluator
  const { setSendUpdate, startEvaluation } = await import(
    '@voxor/lineage-core'
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

        // Track best here too: resumed runs replay their pre-crash history as
        // node_created events with metrics intact — without this, the global
        // best from before an interruption could never win.
        if (
          node.metrics?.fitness !== undefined &&
          (collector.bestNode === null ||
            node.metrics.fitness > (collector.bestNode.metrics?.fitness ?? 0))
        ) {
          collector.bestNode = node;
        }

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
        collector.playoffs.push({ generation: data.generation, ranking: data.ranking, decisive: data.decisive });
        break;
      case 'cost_breakdown':
        collector.costBreakdown = data.breakdown ?? null;
        collector.estimate = data.estimate ?? null;
        collector.ungradedTests = data.ungradedTests ?? collector.ungradedTests;
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
    ungradedTests: 0,
    version: '1.0',
  };

  if (!options?.existingRun) {
    // Persist config + run to DB (matching electron/ipc/handlers.ts behavior)
    const { getDatabase } = await import('@voxor/lineage-core');
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
      const { estimateRunCost, getModelCost } = await import('@voxor/lineage-core');
      const est = await estimateRunCost(config, getModelCost);
      const scope = est.perGeneration ? ' per generation' : '';
      process.stderr.write(`Estimated cost${scope}: $${est.low.toFixed(4)} – $${est.high.toFixed(4)} (~${est.calls} calls)\n`);
      for (const w of est.warnings) process.stderr.write(`  note: ${w}\n`);
      // Stamp the preflight snapshot on the run BEFORE the insert below persists
      // it — a run killed during initial fill then still carries its estimate
      run.estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };
    } catch (err: any) {
      process.stderr.write(`Cost estimate unavailable: ${err.message}\n`);
    }
    process.stderr.write('\n');

    db.prepare(
      'INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)',
    ).run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
    // Durable before the first paid call: a crash inside the debounce window
    // left no run row at all, so `--resume <runId>` answered "Run not found"
    // for a run that had already spent money.
    if (!db.flush()) {
      process.stderr.write(
        'Warning: the run row is not on disk yet (a retry is scheduled). If this process dies now, --resume will not find it.\n',
      );
    }
  } else {
    const finishedCount = run.generations.flat().filter((n) => n.status === 'finished').length;
    const from = run.generations.length > 0 ? `generation ${run.generations.length - 1}` : 'the start';
    process.stderr.write(
      // Prefer the SPEND LEDGER over the checkpoint. The checkpoint is written
      // periodically; the sidecar records every settled call, so after a crash
      // it is the larger and correct figure — the engine already adopts it, and
      // the banner quoting the checkpoint understated real spend to the user
      // ($0.0010 against a true $0.0011452).
      `Resuming run ${run.id.slice(0, 8)} from ${from} (${finishedCount} finished nodes, ` +
      `$${resumeSpend(run).toFixed(4)} already spent)\n\n`,
    );
    // Completed playoffs are checkpointed on the run and never re-judged
    // (dedupe guard) — seed the collector so results.json keeps them.
    // Same for the ungraded count — a resumed run must not forget that some
    // of its scores were fabricated.
    collector.ungradedTests = run.ungradedTests ?? collector.ungradedTests;
    for (const p of run.playoffs ?? []) {
      collector.playoffs.push({ generation: p.generation, ranking: p.ranking, decisive: p.decisive });
    }
  }

  // Start the evaluation — catch synchronous setup errors
  try {
    await startEvaluation(runId, config, run);
  } catch (err: any) {
    const finishedAt = Date.now();
    collector.error = err.message ?? String(err);
    display.onError(collector.error!);
    return buildResult(config, run, collector, finishedAt, processStartedAt);
  }

  // Wait for completion (resolves on 'finished' status)
  await finishedPromise;

  const finishedAt = Date.now();
  const result = buildResult(config, run, collector, finishedAt, processStartedAt);

  if (result.holdout?.seed && result.holdout?.champion) {
    process.stderr.write(`Generalization (unseen tests): seed ${result.holdout.seed.score.toFixed(2)} → champion ${result.holdout.champion.score.toFixed(2)}\n`);
  }

  // Write JSON result to stdout for piping — unless --output already wrote it
  // to a file. `--output <path>  Write JSON results to file (default: stdout)`
  // reads as either/or, and printing a 7KB duplicate to a terminal after
  // writing the file is just noise.
  if (!options?.suppressStdout) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  return result;
}
