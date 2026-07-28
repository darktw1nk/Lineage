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

export interface GenerationResult {
  newNodes: CandidateNode[];
  costTracking: {
    promptTokens: number;
    completionTokens: number;
    usd: number;
    calls: number;
  };
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
  targetPopSize: number
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
    const j = Math.floor(Math.random() * (i + 1));
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
  allGenerations: CandidateNode[][] // All previous generations for elitism
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
  
  // Calculate remaining children to create via genetic operators
  const remainingChildren = targetPopSize - numElite;
  console.log(`[Generation] Creating ${remainingChildren} new children via genetic operators (${numElite} elites already added)`);
  
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
  for (let i = operatorPlan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [operatorPlan[i], operatorPlan[j]] = [operatorPlan[j], operatorPlan[i]];
  }
  
  // Step 6: Create parent stream (weighted cycling with fair distribution)
  const parentAssignments = assignParentsToChildren(topPerformers, remainingChildren);
  let parentIndex = 0;
  const nextParent = () => {
    const parent = parentAssignments[parentIndex % parentAssignments.length];
    parentIndex++;
    return parent;
  };
  
  // Cost tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Step 7: Create children per operator plan (one operator per child, no layering)
  // Process all children in PARALLEL
  console.log(`[Generation] Creating ${remainingChildren} children in parallel...`);
  
  const childCreationPromises = [];
  
  for (let i = 0; i < remainingChildren; i++) {
    const operatorName = operatorPlan[i];
    const parent = nextParent();
    const parentFitness = parent.metrics?.fitness || 0;

    const childPromise = (async () => {
      const carry = (label: 'CARRY' | 'ERROR', text: string) => ({
        prompt: parent.prompt,
        changeLog: [{ label, text }] as ChangeLogLine[],
        lineageParents: [parent.id],
        params: { ...parent.params },
        operatorType: null as string | null,
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      });

      if (!operatorName) {
        return carry('CARRY', 'No operator assigned (all shares 0)');
      }
      const op = getOperator(operatorName);
      if (!op) {
        return carry('CARRY', `Operator '${operatorName}' not registered`);
      }

      try {
        const parentB = op.parents === 2 ? nextParent() : undefined;
        const result = await op.apply({ parent, parentB, config, generation: currentGeneration });

        console.log(`[Generation] Child ${i}: ${operatorName.toUpperCase()} from parent ${parent.id.slice(0, 8)}`);

        return {
          prompt: result.prompt,
          changeLog: result.changeLog,
          lineageParents: parentB ? [parent.id, parentB.id] : [parent.id],
          params: { ...parent.params, ...result.params },
          operatorType: operatorName as string | null,
          cost: result.cost,
        };
      } catch (error) {
        console.error(`[Generation] Operator '${operatorName}' failed for child ${i}:`, error);
        return carry('ERROR', `Operator '${operatorName}' failed, using parent`);
      }
    })().then(result => ({ index: i, parent, parentFitness, result }));

    childCreationPromises.push(childPromise);
  }
  
  // Wait for all children to be created in parallel
  const childResults = await Promise.all(childCreationPromises);
  
  // Process results in order and create nodes
  for (const { parentFitness, result } of childResults) {
    // Accumulate costs
    totalPromptTokens += result.cost.promptTokens;
    totalCompletionTokens += result.cost.completionTokens;
    totalUsd += result.cost.usd;
    totalCalls += result.cost.calls;

    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: nextGenerationNumber,
      lineageParents: result.lineageParents,
      status: 'awaiting',
      prompt: result.prompt,
      params: { ...result.params, temperature: result.params.temperature ?? 0.7 },
      changeLog: result.changeLog,
    };

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

