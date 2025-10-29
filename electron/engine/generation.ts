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
  UUID,
  EvaluationConfig,
  CandidateNode,
  ChangeLogLine,
} from '../../src/types/index.js';
import { mutateNode, crossoverNodes, metaPromptNode } from './operators_v2.js';
import { varyParameters } from './paramvariation.js';
import { varyModel } from './modelvariation.js';

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
  const sorted = currentGeneration
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!);

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
      const lastGen = allGenerations[allGenerations.length - 1]; // Previous generation
      for (const node of lastGen) {
        if (node.status === 'finished' && node.metrics?.fitness !== undefined) {
          lastGenFinishedNodes.push(node);
        }
      }
      
      // Sort by fitness descending
      lastGenFinishedNodes.sort((a, b) => b.metrics!.fitness! - a.metrics!.fitness!);
      
      // Take top N elites from last generation
      const elites = lastGenFinishedNodes.slice(0, Math.min(numElite, lastGenFinishedNodes.length));
      
      console.log(`[Generation] Elitism: carrying over ${elites.length} best nodes from generation ${nextGenerationNumber - 1}`);
      
      // Clone elites to new generation (reset status, update generation number)
      for (const elite of elites) {
        const eliteClone: CandidateNode = {
          ...elite,
          id: uuidv4(),
          generation: nextGenerationNumber,
          status: 'awaiting',
          lineageParents: [elite.id],
          changeLog: [{ label: 'ELITE', text: `Elite from gen ${elite.generation} (fitness=${elite.metrics?.fitness?.toFixed(3)})` }],
          // Keep same prompt and params
        };
        newGenNodes.push(eliteClone);
        
        // Track as "carry forward" for operator effectiveness
        (eliteClone as any)._operatorType = 'carry';
        (eliteClone as any)._parentFitness = elite.metrics?.fitness || 0;
      }
    }
  }
  
  // Calculate remaining children to create via genetic operators
  const remainingChildren = targetPopSize - numElite;
  console.log(`[Generation] Creating ${remainingChildren} new children via genetic operators (${numElite} elites already added)`);
  
  // Step 1: Collect operator shares (all treated equally)
  const shareMutation = config.operators.mutationShare || 0;
  const shareCrossover = config.operators.crossoverShare || 0;
  const shareMeta = config.operators.metaPrompting?.enabled ? (config.operators.metaPrompting.share || 0) : 0;
  const shareParam = config.operators.paramVariation?.enabled ? (config.operators.paramVariation.share || 0) : 0;
  const shareModel = config.operators.modelVariation?.enabled ? (config.operators.modelVariation.share || 0) : 0;
  
  const totalShare = shareMutation + shareCrossover + shareMeta + shareParam + shareModel;
  
  if (totalShare === 0) {
    console.warn(`[Generation] All operator shares are 0, using pure carry-forward`);
    // Fall back to carrying forward all parents
  }
  
  // Step 2: Normalize shares and calculate exact counts
  const wMutation = totalShare > 0 ? shareMutation / totalShare : 0;
  const wCrossover = totalShare > 0 ? shareCrossover / totalShare : 0;
  const wMeta = totalShare > 0 ? shareMeta / totalShare : 0;
  const wParam = totalShare > 0 ? shareParam / totalShare : 0;
  const wModel = totalShare > 0 ? shareModel / totalShare : 0;
  
  const qMutation = wMutation * remainingChildren;
  const qCrossover = wCrossover * remainingChildren;
  const qMeta = wMeta * remainingChildren;
  const qParam = wParam * remainingChildren;
  const qModel = wModel * remainingChildren;
  
  let numMutation = Math.floor(qMutation);
  let numCrossover = Math.floor(qCrossover);
  let numMeta = Math.floor(qMeta);
  let numParam = Math.floor(qParam);
  let numModel = Math.floor(qModel);
  
  // Step 3: Distribute remainder using largest fractional parts
  const remainders = [
    { op: 'mutation', remainder: qMutation - numMutation, count: () => numMutation++, },
    { op: 'crossover', remainder: qCrossover - numCrossover, count: () => numCrossover++, },
    { op: 'meta', remainder: qMeta - numMeta, count: () => numMeta++, },
    { op: 'param', remainder: qParam - numParam, count: () => numParam++, },
    { op: 'model', remainder: qModel - numModel, count: () => numModel++, },
  ];
  
  remainders.sort((a, b) => b.remainder - a.remainder);
  
  let slotsLeft = remainingChildren - (numMutation + numCrossover + numMeta + numParam + numModel);
  for (let i = 0; i < slotsLeft && i < remainders.length; i++) {
    remainders[i].count();
  }
  
  console.log(`[Generation] Operator counts (normalized): mutation=${numMutation}, crossover=${numCrossover}, meta=${numMeta}, param=${numParam}, model=${numModel}`);
  
  // Step 4: Build shuffled operator plan
  const operatorPlan: Array<'mutation' | 'crossover' | 'meta' | 'param' | 'model'> = [];
  for (let i = 0; i < numMutation; i++) operatorPlan.push('mutation');
  for (let i = 0; i < numCrossover; i++) operatorPlan.push('crossover');
  for (let i = 0; i < numMeta; i++) operatorPlan.push('meta');
  for (let i = 0; i < numParam; i++) operatorPlan.push('param');
  for (let i = 0; i < numModel; i++) operatorPlan.push('model');
  
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
  for (let i = 0; i < remainingChildren; i++) {
    const operator = operatorPlan[i];
    const parent = nextParent();
    const parentFitness = parent.metrics?.fitness || 0;
    
    let prompt = parent.prompt;
    let changeLog: ChangeLogLine[] = [];
    let lineageParents: string[] = [parent.id];
    let temperature = parent.params.temperature || 0.7;
    let model = parent.params.model;
    let operatorType: 'mutation' | 'crossover' | 'meta' | 'param' | 'model' | null = null;
    
    try {
      if (operator === 'mutation') {
        // MUTATE: apply mutation to prompt
        const result = await mutateNode(parent.prompt, config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'mutation';
        
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: MUTATION from parent ${parent.id.slice(0, 8)}`);
        
      } else if (operator === 'crossover') {
        // CROSSOVER: merge two distinct parents
        const parentB = nextParent();
        
        const result = await crossoverNodes(parent, parentB, config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        lineageParents = [parent.id, parentB.id]; // Track BOTH parents
        operatorType = 'crossover';
        
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: CROSSOVER from ${parent.id.slice(0, 8)} × ${parentB.id.slice(0, 8)}`);
        
      } else if (operator === 'meta') {
        // META: targeted mutation from failure summary
        const result = await metaPromptNode(parent, config, currentGeneration);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'meta';
        
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: META from parent ${parent.id.slice(0, 8)}`);
        
      } else if (operator === 'param') {
        // PARAM: apply parameter variation using dedicated function
        const paramVariation = varyParameters(
          temperature,
          config,
          true // Force variation since we're in param slot
        );
        
        temperature = paramVariation.temperature;
        changeLog = paramVariation.changeLog;
        operatorType = 'param';
        
        console.log(`[Generation] Child ${i}: PARAM from parent ${parent.id.slice(0, 8)} (temp ${temperature.toFixed(2)})`);
        
      } else if (operator === 'model') {
        // MODEL: apply model variation using dedicated function
        const modelVariation = varyModel(
          model,
          config,
          true, // Force variation since we're in model slot
          config.enabledModels
        );
        
        if (modelVariation.changeLog.length > 0) {
          model = modelVariation.model;
          changeLog = modelVariation.changeLog;
          operatorType = 'model';
          
          console.log(`[Generation] Child ${i}: MODEL from parent ${parent.id.slice(0, 8)} (${model.provider}/${model.model})`);
        } else {
          // Shouldn't happen since we force variation, but safety fallback
          changeLog = [{ label: 'CARRY', text: 'Model variation skipped (no other models available)' }];
          console.log(`[Generation] Child ${i}: MODEL skipped (no alternatives)`);
        }
      }
    } catch (error) {
      console.error(`[Generation] Operator '${operator}' failed for child ${i}:`, error);
      // Fallback to parent
      prompt = parent.prompt;
      changeLog = [{ label: 'ERROR', text: `Operator '${operator}' failed, using parent` }];
    }
    
    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: nextGenerationNumber,
      lineageParents,
      status: 'awaiting',
      prompt,
      params: { model, temperature },
      changeLog,
    };
    
    newGenNodes.push(newNode);
    
    // Track operator effectiveness (will update after this node is evaluated)
    // Store parent fitness and operator type for later delta calculation
    (newNode as any)._operatorType = operatorType;
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

