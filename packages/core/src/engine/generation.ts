/**
 * Generation Creation and Selection
 * 
 * Orchestrates the creation of new generations through:
 * - Selection (Top-K, Top-P)
 * - Elitism: carry over best performers from PREVIOUS generation
 * - Fair weighted distribution: better parents get more children proportional to rank
 * - Fixed population size: each generation has exactly the same number of nodes
 * - Guaranteed participation: when Y >= N, every parent gets at least 1 child
 * - Unified operator model: mutation, crossover, meta-prompting, param variation, model variation
 * - All operators treated equally: normalized shares, no layering
 * - Proper lineage tracking (crossover tracks BOTH parents)
 * 
 * Generation Creation Flow:
 * 1. Elitism Phase (optional, if eliteShare > 0, default 0.05):
 *    - Calculate elite count: E = max(1, round(popSize * eliteShare)) - minimum 1 elite when enabled
 *    - Collect finished nodes from PREVIOUS generation only
 *    - Sort by fitness (best first)
 *    - Clone top E nodes to new generation (keep prompt/params, reset status)
 * 
 * 2. Operator Normalization Phase:
 *    a. Collect all operator shares: mutation, crossover, meta, param, model
 *    b. Normalize shares to sum to 100% (largest remainder method)
 *    c. Calculate exact counts for each operator summing to (popSize - E)
 *    d. Build shuffled operator plan for temporal fairness
 * 
 * 3. Parent Selection Phase:
 *    a. Select top X performers from CURRENT generation (Top-K or Top-P)
 *    b. Calculate rank weights: best=X, 2nd=X-1, ..., worst=1
 *    c. Assign parents to (popSize - E) children:
 *       - If remaining >= X: seed 1 per parent, distribute rest proportionally
 *       - If remaining < X: pure proportional (some may get 0)
 * 
 * 4. Child Creation Phase:
 *    - For each slot in operator plan:
 *      - Get next parent from weighted stream
 *      - Apply ONE operator (mutation/crossover/meta/param/model)
 *      - No layering - each child gets exactly one transformation
 * 
 * Example (10 nodes, eliteShare=0.05, 3 current-gen parents):
 *   Elite: 1 node (best from previous generation)
 *   Remaining: 9 children
 *   Parent weights: [3, 2, 1]
 *   Seed: P1=1, P2=1, P3=1 (3 total)
 *   Distribute 6 more: P1=3, P2=2, P3=1 (by weights)
 *   Final: 1 elite + [P1=4, P2=3, P3=2] = 10 ✅
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  EvaluationConfig,
  CandidateNode,
  ChangeLogLine,
} from '../types.js';
import { getOperator } from '../registry.js';
import { rngFor } from './rng.js';
import { partialCostOf } from './operator-cost.js';

export interface GenerationResult {
  newNodes: CandidateNode[];
  costTracking: {
    promptTokens: number;
    completionTokens: number;
    usd: number;
    calls: number;
  };
}

type OperatorCost = { promptTokens: number; completionTokens: number; usd: number; calls: number };

/** A defensive copy handed to operators so a plugin cannot mutate live state. */
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Operators are a plugin surface: `docs/plugins.md` promises a bad plugin
 * "contributes nothing" and the host keeps running. Nothing enforced that.
 * A result missing `cost` threw a TypeError *outside* the per-child catch,
 * which escaped createNextGeneration into an unawaited evaluationLoop and
 * killed the process; a result missing `prompt` was accepted and the child
 * was silently evaluated with no system prompt at all; a NaN `usd` poisoned
 * run totals and disabled budget enforcement (NaN > limit is never true).
 *
 * Throwing here routes every one of those onto the existing carry-forward
 * path, exactly like an operator that threw.
 */
function validateOperatorResult(
  result: any,
  operatorName: string,
): { prompt: string; changeLog: ChangeLogLine[]; params: Record<string, any>; cost: OperatorCost } {
  if (!result || typeof result !== 'object') {
    throw new Error(`Operator '${operatorName}' returned ${result === undefined ? 'undefined' : typeof result}, expected an OperatorResult object`);
  }
  if (typeof result.prompt !== 'string' || result.prompt.trim() === '') {
    throw new Error(`Operator '${operatorName}' returned a ${typeof result.prompt} prompt, expected a non-empty string`);
  }
  const changeLog: ChangeLogLine[] = Array.isArray(result.changeLog)
    ? result.changeLog.filter((line: any) => line && typeof line === 'object')
    : [];
  const params = result.params && typeof result.params === 'object' && !Array.isArray(result.params)
    ? result.params
    : {};
  const rawCost = result.cost && typeof result.cost === 'object' ? result.cost : {};
  return {
    prompt: result.prompt,
    changeLog,
    params,
    cost: {
      promptTokens: finite(rawCost.promptTokens),
      completionTokens: finite(rawCost.completionTokens),
      usd: finite(rawCost.usd),
      calls: finite(rawCost.calls),
    },
  };
}

/**
 * How many provider calls an operator may make before we consider it hung.
 *
 * The timeout is a LIVENESS check for a plugin whose apply() never resolves —
 * not a latency budget. Bounding the whole operator by a single call's timeout
 * was wrong: mutation makes up to retries+1 proposal calls plus an apply call,
 * and meta-prompting makes two, each legitimately entitled to callTimeoutMs. At
 * the 120s default, a service model taking >60s a call turned EVERY mutation
 * into a carry-forward — evolution silently stopped while the spend stayed
 * invisible. Anyone lowering callTimeoutMs to fail fast disabled all operators.
 */
const OPERATOR_CALL_BUDGET = 6;

/**
 * `callTimeoutMs` bounds provider calls but never bounded the operator itself,
 * so a plugin whose apply() never resolved hung the whole run forever.
 */
function withOperatorTimeout<T>(work: Promise<T>, callTimeoutMs: number, operatorName: string): Promise<T> {
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) return work;
  const timeoutMs = callTimeoutMs * OPERATOR_CALL_BUDGET;
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(
          `Operator '${operatorName}' did not finish within ${timeoutMs}ms ` +
          `(${OPERATOR_CALL_BUDGET} x callTimeoutMs) — treating it as hung`,
        )),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Select top performers from current generation
 */
export function selectTopPerformers(
  currentGeneration: CandidateNode[],
  config: EvaluationConfig
): CandidateNode[] {
  // Playoff-rank aware: pairwise playoff winners outrank raw fitness (rank 1 first,
  // unranked nodes sort after ranked ones by fitness)
  const sorted = currentGeneration
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => {
      const ra = a.metrics?.playoffRank ?? Infinity;
      const rb = b.metrics?.playoffRank ?? Infinity;
      if (ra !== rb) return ra - rb;
      return b.metrics!.fitness! - a.metrics!.fitness!;
    });

  let topPerformers: CandidateNode[];
  
  if (config.selection.policy === 'topp') {
    // Top-P selection
    const topP = config.selection.topP || 0.5;
    const totalFitness = sorted.reduce((sum, n) => sum + (n.metrics?.fitness || 0), 0);
    // All-zero fitness means the cumulative share is 0/0 = NaN and no cutoff can
    // ever trip — take everyone rather than collapsing to a single parent.
    let cutoff = sorted.length;
    if (totalFitness > 0) {
      let cumulative = 0;
      for (let i = 0; i < sorted.length; i++) {
        cumulative += (sorted[i].metrics?.fitness || 0) / totalFitness;
        // Epsilon: with topP=1.0 float error leaves the sum at 0.999...,
        // which would otherwise leave the sentinel untouched
        if (cumulative >= topP - 1e-9) {
          cutoff = i + 1;
          break;
        }
      }
    }
    topPerformers = sorted.slice(0, Math.max(1, cutoff));
    console.log(`[Generation] Selected ${topPerformers.length} top performers (Top-P=${topP})`);
  } else {
    // Top-K selection
    const topK = config.selection.topK || Math.ceil(sorted.length * 0.4);
    topPerformers = sorted.slice(0, topK);
    console.log(`[Generation] Selected ${topPerformers.length} top performers (Top-K=${topK})`);
  }

  return topPerformers;
}

/**
 * Create weighted parent assignments for exactly Y children
 * Better parents get more children proportional to their rank
 * GUARANTEES all parents get at least 1 child when Y >= numParents
 * 
 * Algorithm:
 * 1. If Y >= N: give 1 child to each parent, then distribute remaining (Y-N) by rank weights
 * 2. If Y < N: distribute all Y children by rank weights (some parents get 0)
 * 
 * Assumes parents are sorted best→worst (weights = [N, N-1, ..., 1])
 */
function assignParentsToChildren(
  parents: CandidateNode[],
  targetPopSize: number,
  rng: () => number = Math.random
): CandidateNode[] {
  const numParents = parents.length;
  
  // Edge cases
  if (numParents === 0 || targetPopSize <= 0) {
    console.warn(`[Generation] Invalid inputs: ${numParents} parents, ${targetPopSize} children`);
    return [];
  }
  
  // Single parent → all children from this parent
  if (numParents === 1) {
    const assignments = new Array(targetPopSize).fill(parents[0]);
    console.log(`[Generation] Single parent → all ${targetPopSize} children`);
    return assignments;
  }
  
  // Rank weights: best = numParents, 2nd = numParents-1, ..., worst = 1
  const weights: number[] = [];
  for (let i = 0; i < numParents; i++) {
    weights.push(numParents - i);
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  
  const counts: number[] = new Array(numParents).fill(0);
  
  // Guarantee at least 1 child per parent (if we have enough children)
  if (targetPopSize >= numParents) {
    // Seed: 1 per parent
    for (let i = 0; i < numParents; i++) {
      counts[i] = 1;
    }
    
    // Distribute remaining children proportionally
    const remaining = targetPopSize - numParents;
    if (remaining > 0) {
      const quotas = weights.map(w => (w / totalWeight) * remaining);
      const floors = quotas.map(q => Math.floor(q));
      const remainders = quotas.map((q, i) => ({ index: i, remainder: q - floors[i] }));
      
      // Add floor counts
      for (let i = 0; i < numParents; i++) {
        counts[i] += floors[i];
      }
      
      // Distribute leftover slots by largest remainder
      let distributed = floors.reduce((sum, f) => sum + f, 0);
      const leftover = remaining - distributed;
      remainders.sort((a, b) => b.remainder - a.remainder);
      for (let i = 0; i < leftover; i++) {
        counts[remainders[i].index]++;
      }
    }
  } else {
    // Not enough children for everyone → pure proportional (some may get 0)
    const quotas = weights.map(w => (w / totalWeight) * targetPopSize);
    const floors = quotas.map(q => Math.floor(q));
    const remainders = quotas.map((q, i) => ({ index: i, remainder: q - floors[i] }));
    
    // Add floor counts
    for (let i = 0; i < numParents; i++) {
      counts[i] = floors[i];
    }
    
    // Distribute leftover slots by largest remainder
    let distributed = floors.reduce((sum, f) => sum + f, 0);
    const leftover = targetPopSize - distributed;
    remainders.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < leftover; i++) {
      counts[remainders[i].index]++;
    }
  }
  
  // Build assignments array
  const assignments: CandidateNode[] = [];
  for (let i = 0; i < numParents; i++) {
    for (let j = 0; j < counts[i]; j++) {
      assignments.push(parents[i]);
    }
  }
  
  // Shuffle for randomness while preserving counts
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }
  
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  console.log(`[Generation] Parent assignments: ${numParents} parents → ${targetPopSize} children`);
  console.log(`[Generation] Distribution (min=${minCount}, max=${maxCount}): ${counts.map((c, i) => `P${i+1}=${c}`).join(', ')}`);
  
  return assignments;
}

/**
 * Create next generation from top performers
 * Uses fair weighted cycling: better parents get more children, but all contribute
 */
export async function createNextGeneration(
  topPerformers: CandidateNode[],
  currentGeneration: CandidateNode[],
  nextGenerationNumber: number,
  config: EvaluationConfig,
  allGenerations: CandidateNode[][], // All previous generations for elitism
  /**
   * Budget gate for the operator calls this transition is about to make.
   *
   * There was none. `shouldStop` let the transition BEGIN with one cent left,
   * and then the entire generation's operator spend executed in a single
   * unbounded Promise.all — measured at $32 against a $9 cap (356%), of which
   * 24 calls were ungated operator work fired after the cap was already
   * reached. `reserve` throws when the call does not fit; the per-child catch
   * below turns that into a CARRY, so the parent advances unchanged and unpaid.
   */
  budget?: {
    reserve: (promptText: string) => Promise<number>;
    release: (reserved: number) => void;
    exhausted: () => boolean;
  },
): Promise<GenerationResult> {
  const newGenNodes: CandidateNode[] = [];
  
  // Determine target population size
  // Gen 0 → N+1: use config.population.generationSize
  // Gen 0 has config.population.initialSize (but we're never called for gen 0)
  const targetPopSize = config.population.generationSize;
  console.log(`[Generation] Creating ${targetPopSize} children from ${topPerformers.length} parents`);
  
  // Elitism: carry over best nodes from LAST generation
  let numElite = 0;
  const eliteShare = config.selection.eliteShare || 0;
  if (eliteShare > 0 && nextGenerationNumber > 0) {
    // When elitism is enabled, always carry at least 1 best node
    numElite = Math.max(1, Math.round(targetPopSize * eliteShare));
    
    if (numElite > 0) {
      // Collect finished nodes from LAST generation only
      const lastGenFinishedNodes: CandidateNode[] = [];
      // Note: allGenerations may have an empty array at the end (current generation being created)
      // So we need to get the second-to-last or the last non-empty generation
      const lastGen = allGenerations.length >= 2 && allGenerations[allGenerations.length - 1].length === 0
        ? allGenerations[allGenerations.length - 2] // If last is empty, get second-to-last
        : allGenerations[allGenerations.length - 1]; // Otherwise get last
      
      for (const node of lastGen) {
        if (node.status === 'finished' && node.metrics?.fitness !== undefined) {
          lastGenFinishedNodes.push(node);
        }
      }
      
      // Elitism must never consume the whole population: with numElite ===
      // targetPopSize every child is a finished clone, nothing is queued, and
      // the run ends silently with no stopReason and no evolution at all.
      numElite = Math.min(numElite, Math.max(0, targetPopSize - 1));

      // Sort playoff-rank first (rank 1 = playoff winner), then fitness descending
      lastGenFinishedNodes.sort((a, b) => {
        const ra = a.metrics?.playoffRank ?? Infinity;
        const rb = b.metrics?.playoffRank ?? Infinity;
        if (ra !== rb) return ra - rb;
        return b.metrics!.fitness! - a.metrics!.fitness!;
      });

      // Take top N elites from last generation
      const elites = lastGenFinishedNodes.slice(0, Math.min(numElite, lastGenFinishedNodes.length));
      
      console.log(`[Generation] Elitism: carrying over ${elites.length} best nodes from generation ${nextGenerationNumber - 1}`);
      
      // Clone elites - keep them finished so they don't get re-evaluated
      for (const elite of elites) {
        // Clone sheds the stale playoffRank — it competes in the next playoff on its own
        const { playoffRank: _stalePlayoffRank, ...eliteMetrics } = elite.metrics ?? {};
        const eliteClone: CandidateNode = {
          ...elite,  // Copy everything
          id: uuidv4(),  // New ID
          generation: nextGenerationNumber,  // New generation number
          status: 'finished',  // KEEP AS FINISHED - don't re-evaluate
          lineageParents: [elite.id],
          metrics: elite.metrics ? eliteMetrics : undefined,
          changeLog: [{ label: 'ELITE', text: `Elite from gen ${elite.generation} (fitness=${elite.metrics?.fitness?.toFixed(3)})` }],
        };
        newGenNodes.push(eliteClone);
        
        (eliteClone as any)._operatorType = 'elite';
        (eliteClone as any)._parentFitness = elite.metrics?.fitness || 0;
      }
    }
  }
  
  // Calculate remaining children to create via genetic operators.
  // Subtract the elites ACTUALLY added, not the number requested: when the
  // previous generation had fewer finished nodes than eliteShare asks for,
  // subtracting the request silently shrinks the generation.
  const remainingChildren = targetPopSize - newGenNodes.length;
  console.log(`[Generation] Creating ${remainingChildren} new children via genetic operators (${newGenNodes.length} elites already added)`);
  
  // Step 1: Collect shares for every referenced operator (built-ins from the
  // legacy fields; plugin operators from operators.custom, which also overrides
  // legacy fields when it names a built-in).
  const shares = new Map<string, number>();
  shares.set('mutation', config.operators.mutationShare || 0);
  shares.set('crossover', config.operators.crossoverShare || 0);
  shares.set('meta', config.operators.metaPrompting?.enabled ? (config.operators.metaPrompting.share || 0) : 0);
  shares.set('param', config.operators.paramVariation?.enabled ? (config.operators.paramVariation.share || 0) : 0);
  shares.set('model', config.operators.modelVariation?.enabled ? (config.operators.modelVariation.share || 0) : 0);

  for (const [name, entry] of Object.entries(config.operators.custom ?? {})) {
    if (!getOperator(name)) {
      console.warn(`[Generation] Unknown operator '${name}' in operators.custom — is its plugin loaded? Ignoring.`);
      continue;
    }
    shares.set(name, entry.enabled === false ? 0 : (entry.share || 0));
  }

  const totalShare = [...shares.values()].reduce((a, b) => a + b, 0);
  if (totalShare === 0) {
    console.warn(`[Generation] All operator shares are 0, using pure carry-forward`);
  }

  // Step 2-3: Normalize with the largest-remainder method
  const counts = new Map<string, number>();
  const remainders: Array<{ name: string; remainder: number }> = [];
  let assigned = 0;
  for (const [name, share] of shares) {
    const quota = totalShare > 0 ? (share / totalShare) * remainingChildren : 0;
    const base = Math.floor(quota);
    counts.set(name, base);
    assigned += base;
    remainders.push({ name, remainder: quota - base });
  }
  remainders.sort((a, b) => b.remainder - a.remainder);
  if (totalShare > 0) {
    for (let i = 0; i < remainingChildren - assigned; i++) {
      const r = remainders[i % remainders.length];
      counts.set(r.name, (counts.get(r.name) || 0) + 1);
    }
  }

  console.log(`[Generation] Operator counts (normalized):`, Object.fromEntries(counts));

  // Step 4: Build shuffled operator plan
  const operatorPlan: string[] = [];
  for (const [name, n] of counts) {
    for (let i = 0; i < n; i++) operatorPlan.push(name);
  }
  
  // Step 5: Shuffle operator plan for fairness across time
  const planRng = rngFor(config.seed, 'operator-plan', nextGenerationNumber);
  for (let i = operatorPlan.length - 1; i > 0; i--) {
    const j = Math.floor(planRng() * (i + 1));
    [operatorPlan[i], operatorPlan[j]] = [operatorPlan[j], operatorPlan[i]];
  }

  // Step 6: Create parent stream (weighted cycling with fair distribution)
  const parentAssignments = assignParentsToChildren(
    topPerformers,
    remainingChildren,
    rngFor(config.seed, 'parent-assign', nextGenerationNumber)
  );
  let parentIndex = 0;
  const nextParent = () => {
    const parent = parentAssignments[parentIndex % parentAssignments.length];
    parentIndex++;
    return parent;
  };

  // Binary operators need two DIFFERENT parents. Cycling the assignment list
  // blindly handed crossover the same node twice whenever one performer
  // dominated (topK: 1, or only one node finishing a generation), which spent
  // a full service-model call merging a prompt with itself.
  const distinctParents = topPerformers.length > 1;
  const pickSecondParent = (first: CandidateNode) => {
    let candidate = nextParent();
    if (!distinctParents) return candidate;
    for (let tries = 0; candidate.id === first.id && tries < parentAssignments.length; tries++) {
      candidate = nextParent();
    }
    return candidate;
  };
  
  // Cost tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Step 7: Create children per operator plan (one operator per child, no layering)
  //
  // Parents are drawn HERE, in plan order, so the assignment stays identical
  // regardless of how the work is then scheduled — a seeded run must reproduce.
  const childPlan = Array.from({ length: remainingChildren }, (_, i) => {
    const parent = nextParent();
    return { i, operatorName: operatorPlan[i], parent, parentFitness: parent.metrics?.fitness || 0 };
  });

  // Bounded by parallelLimit, NOT one promise per child.
  //
  // Every child used to call apply() in the same tick, and withOperatorTimeout
  // starts its 6 x callTimeoutMs clock at that moment — but the resulting
  // service calls then queued on the global semaphore. So a child at the back
  // of the queue burned its whole budget WAITING, and was declared hung.
  // Measured with parallelLimit 2 and 500ms calls: popSize 10 lost 1 child to
  // the timeout, popSize 20 lost 2, popSize 40 lost 13 (33%). Past the cliff
  // every child is a carry-forward clone of its parent — evolution silently
  // stops while the run still reports success.
  const childPoolSize = Math.max(1, Math.min(config.parallelLimit || 1, remainingChildren));
  console.log(`[Generation] Creating ${remainingChildren} children (${childPoolSize} at a time)...`);

  type ChildOutcome = { index: number; parent: CandidateNode; parentFitness: number; result: any };
  const childResults: ChildOutcome[] = new Array(remainingChildren);
  let nextChild = 0;

  const createChild = async ({ i, operatorName, parent, parentFitness }: typeof childPlan[number]) => {
    const outcome = await (async () => {
      const carry = (
        label: 'CARRY' | 'ERROR',
        text: string,
        // A failed operator has usually already made (and been billed for)
        // several LLM calls — carrying zero cost hides that spend from totals,
        // the breakdown, and the budget check.
        cost = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      ) => ({
        prompt: parent.prompt,
        changeLog: [{ label, text }] as ChangeLogLine[],
        lineageParents: [parent.id],
        params: { ...parent.params },
        operatorType: null as string | null,
        cost,
      });

      if (!operatorName) {
        return carry('CARRY', 'No operator assigned (all shares 0)');
      }
      const op = getOperator(operatorName);
      if (!op) {
        return carry('CARRY', `Operator '${operatorName}' not registered`);
      }
      if (budget?.exhausted()) {
        return carry('CARRY', 'Budget exhausted before this operator ran');
      }

      try {
        const parentB = op.parents === 2 ? pickSecondParent(parent) : undefined;
        const childRng = rngFor(config.seed, 'operator', nextGenerationNumber, i);
        // Operators — including third-party plugins — receive snapshots. A
        // plugin that mutated the live parent rewrote the already-scored
        // parent node in place and every sibling saw the damage, because the
        // same object was handed to all of them.
        // Reserve for the duration of this child's calls. The per-child check
        // above only sees SETTLED spend, and every child reaches it in the same
        // tick, so without a reservation they all pass together.
        const reserved = await budget?.reserve(parent.prompt) ?? 0;
        try {
        const result = await withOperatorTimeout(
          op.apply({
            parent: snapshot(parent),
            parentB: parentB && snapshot(parentB),
            config,
            // Cloned ON ACCESS, not eagerly. `currentGeneration.map(snapshot)`
            // per child is O(popSize^2) structuredClone calls per generation —
            // measured 97-98% of createNextGeneration's wall time, and 584 MB
            // of garbage per transition at popSize 50 with large outputs — for
            // a field NO built-in operator reads (metaPromptNode takes it as
            // `_generation`). A plugin that does read it still gets its own
            // isolated copy; everyone else pays nothing.
            get generation() { return currentGeneration.map(snapshot); },
            rng: childRng,
          }),
          config.callTimeoutMs ?? 120_000,
          operatorName,
        );

        const validated = validateOperatorResult(result, operatorName);

        // A result whose prompt AND params match the parent is a paid no-op
        // (open-bugs 2026-07-31 #1): adopted as-is, its changelog claims a
        // change that never happened and the node re-measures a prompt already
        // measured. Record it as a carry instead — honest changelog, no
        // operator-effectiveness credit, and params inherited exactly so the
        // evaluation cache serves it for free. Operators that return an honest
        // CARRY/ERROR line themselves keep their own wording. This chokepoint
        // covers plugin operators, which never pass mutateNode's gate.
        const promptUnchanged = validated.prompt.trim() === parent.prompt.trim();
        const paramsUnchanged = Object.entries(validated.params).every(
          ([k, v]) => JSON.stringify(v) === JSON.stringify((parent.params as any)[k]),
        );
        const alreadyHonest = ['CARRY', 'ERROR'].includes(String(validated.changeLog[0]?.label));
        if (promptUnchanged && paramsUnchanged && !alreadyHonest) {
          console.warn(
            `[Generation] Operator '${operatorName}' returned the parent unchanged for child ${i} — recording a carry-forward, not a change`,
          );
          return {
            ...carry('CARRY', `Operator '${operatorName}' returned the parent prompt unchanged — carried forward`, validated.cost),
          };
        }

        console.log(`[Generation] Child ${i}: ${operatorName.toUpperCase()} from parent ${parent.id.slice(0, 8)}`);

        return {
          prompt: validated.prompt,
          changeLog: validated.changeLog,
          lineageParents: parentB ? [parent.id, parentB.id] : [parent.id],
          params: { ...parent.params, ...validated.params },
          operatorType: operatorName as string | null,
          cost: validated.cost,
        };
        } finally {
          budget?.release(reserved);
        }
      } catch (error) {
        // A refused reservation is not a failure — it is the cap working.
        if ((error as any)?.name === 'BudgetExhaustedError') {
          return carry('CARRY', 'Budget exhausted before this operator ran');
        }
        console.error(`[Generation] Operator '${operatorName}' failed for child ${i}:`, error);
        const spent = partialCostOf(error);
        if (spent.calls > 0) {
          console.warn(`[Generation] Failed '${operatorName}' still spent $${spent.usd.toFixed(6)} over ${spent.calls} call(s) — accounting for it`);
        }
        // Name the actual cause. "failed, using parent" alone sent the reason
        // to a console.error the desktop hides by default, so a run where every
        // operator failed showed a generation of identical carried prompts with
        // no on-screen explanation anywhere.
        const why = error instanceof Error ? error.message : String(error);
        return carry('ERROR', `Operator '${operatorName}' failed, using parent — ${why}`, spent);
      }
    })();
    childResults[i] = { index: i, parent, parentFitness, result: outcome };
  };

  await Promise.all(Array.from({ length: childPoolSize }, async () => {
    for (;;) {
      const index = nextChild++;
      if (index >= childPlan.length) return;
      await createChild(childPlan[index]);
    }
  }));


  // Process results in order and create nodes
  for (const { index, parentFitness, result } of childResults) {
    // Accumulate costs
    totalPromptTokens += finite(result.cost.promptTokens);
    totalCompletionTokens += finite(result.cost.completionTokens);
    totalUsd += finite(result.cost.usd);
    totalCalls += finite(result.cost.calls);

    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: nextGenerationNumber,
      lineageParents: result.lineageParents,
      status: 'awaiting',
      prompt: result.prompt,
      params: { ...result.params, temperature: result.params.temperature ?? 0.7 },
      changeLog: result.changeLog,
    };

    // Seeded runs: derive a stable per-node provider seed unless inherited from the parent
    if (config.seed !== undefined && newNode.params.seed === undefined) {
      newNode.params.seed = Math.floor(rngFor(config.seed, 'node-seed', nextGenerationNumber, index)() * 2 ** 31);
    }

    newGenNodes.push(newNode);

    // Track operator effectiveness (will update after this node is evaluated)
    // Store parent fitness and operator type for later delta calculation
    (newNode as any)._operatorType = result.operatorType;
    (newNode as any)._parentFitness = parentFitness;
  }
  
  console.log(`[Generation] Created ${newGenNodes.length} children for generation ${nextGenerationNumber}`);
  
  return {
    newNodes: newGenNodes,
    costTracking: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    },
  };
}

