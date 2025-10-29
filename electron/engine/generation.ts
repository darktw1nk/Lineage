/**
 * Generation Creation and Selection
 * 
 * Handles:
 * - Selection (Top-K, Top-P)
 * - Elitism: carry over best performers from PREVIOUS generation
 * - Fair weighted distribution: better parents get more children proportional to rank
 * - Fixed population size: each generation has exactly the same number of nodes
 * - Guaranteed participation: when Y >= N, every parent gets at least 1 child
 * - Genetic operators (mutation, crossover, meta-prompting, carry-forward)
 * - Parameter variation (temperature)
 * - Proper lineage tracking (crossover tracks BOTH parents)
 * 
 * Generation Creation Flow:
 * 1. Elitism Phase (optional, if eliteShare > 0, default 0.05):
 *    - Calculate elite count: E = round(popSize * eliteShare)
 *    - Collect finished nodes from PREVIOUS generation only
 *    - Sort by fitness (best first)
 *    - Clone top E nodes to new generation (keep prompt/params, reset status)
 * 
 * 2. Genetic Operators Phase (remaining children):
 *    a. Select top X performers from CURRENT generation (Top-K or Top-P)
 *    b. Calculate rank weights: best=X, 2nd=X-1, ..., worst=1
 *    c. Assign parents to (popSize - E) children:
 *       - If remaining >= X: seed 1 per parent, distribute rest proportionally
 *       - If remaining < X: pure proportional (some may get 0)
 *    d. Calculate operator counts from shares and shuffle
 *    e. Create children with assigned (parent, operator, model, temperature)
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
  
  // Determine target population size (same as current generation)
  const targetPopSize = currentGeneration.length;
  console.log(`[Generation] Creating ${targetPopSize} children from ${topPerformers.length} parents`);
  
  // Elitism: carry over best nodes from LAST generation
  let numElite = 0;
  const eliteShare = config.selection.eliteShare || 0;
  if (eliteShare > 0 && nextGenerationNumber > 0) {
    numElite = Math.round(targetPopSize * eliteShare);
    
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
  
  // Operator shares (applied to remaining children, not elites)
  const mutationFactor = config.operators.mutationFactor;
  const crossoverFactor = config.operators.crossoverFactor;
  const metaPromptShare = config.operators.metaPrompting?.enabled 
    ? (config.operators.metaPrompting.share || 0.2) 
    : 0;
  const paramVariationShare = config.operators.paramVariation?.enabled 
    ? (config.operators.paramVariation.share || 0.2) 
    : 0;
  
  // Calculate operator counts for remaining children
  let numMeta = Math.round(remainingChildren * metaPromptShare);
  let numCrossover = Math.round(remainingChildren * crossoverFactor);
  let numMutation = Math.round(remainingChildren * mutationFactor);
  
  // Remaining go to carry-forward
  let numCarryForward = remainingChildren - numMeta - numCrossover - numMutation;
  
  // Fix remainders to ensure exact count
  while (numMeta + numCrossover + numMutation + numCarryForward < remainingChildren) {
    numMutation++; // Favor mutation for remainder
  }
  while (numMeta + numCrossover + numMutation + numCarryForward > remainingChildren) {
    if (numCarryForward > 0) numCarryForward--;
    else if (numMutation > 0) numMutation--;
    else if (numCrossover > 0) numCrossover--;
    else numMeta--;
  }
  
  console.log(`[Generation] Operator counts: meta=${numMeta}, crossover=${numCrossover}, mutation=${numMutation}, carry=${numCarryForward}`);
  
  // Assign parents to remaining children with fair weighted distribution
  const parentAssignments = assignParentsToChildren(topPerformers, remainingChildren);
  
  // Shuffle operators for random distribution
  const operators: Array<'meta' | 'crossover' | 'mutation' | 'carry'> = [];
  for (let i = 0; i < numMeta; i++) operators.push('meta');
  for (let i = 0; i < numCrossover; i++) operators.push('crossover');
  for (let i = 0; i < numMutation; i++) operators.push('mutation');
  for (let i = 0; i < numCarryForward; i++) operators.push('carry');
  
  // Shuffle operators
  for (let i = operators.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [operators[i], operators[j]] = [operators[j], operators[i]];
  }
  
  // Cost tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Create remaining children via genetic operators
  for (let i = 0; i < remainingChildren; i++) {
    const parent = parentAssignments[i]; // Direct assignment, no need for modulo
    const model = config.enabledModels[(numElite + i) % config.enabledModels.length]; // Offset by numElite
    const parentFitness = parent.metrics?.fitness || 0;
    const operator = operators[i];
    
    let prompt = parent.prompt;
    let changeLog: ChangeLogLine[] = [];
    let lineageParents: string[] = [parent.id];
    let temperature = 0.7; // Default
    let operatorType: 'mutation' | 'crossover' | 'meta' | 'param' | null = null;
    
    try {
      if (operator === 'meta' && config.operators.metaPrompting?.enabled) {
        // Meta-prompting
        const result = await metaPromptNode(parent, config, currentGeneration);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'meta';
        
        // Track costs
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: Meta-prompting from parent ${parent.id.slice(0, 8)}`);
      } else if (operator === 'crossover' && topPerformers.length > 1) {
        // Crossover - select second parent
        let parentB: CandidateNode;
        do {
          parentB = topPerformers[Math.floor(Math.random() * topPerformers.length)];
        } while (parentB.id === parent.id && topPerformers.length > 1);
        
        const result = await crossoverNodes(parent, parentB, config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        lineageParents = [parent.id, parentB.id]; // Track BOTH parents
        operatorType = 'crossover';
        
        // Track costs
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: Crossover from ${parent.id.slice(0, 8)} × ${parentB.id.slice(0, 8)}`);
      } else if (operator === 'mutation') {
        // Mutation
        const result = await mutateNode(parent.prompt, config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'mutation';
        
        // Track costs
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Child ${i}: Mutation from parent ${parent.id.slice(0, 8)}`);
      } else {
        // Carry forward
        changeLog = [{ label: 'CARRY', text: 'Carried forward (no variation)' }];
        console.log(`[Generation] Child ${i}: Carry forward from parent ${parent.id.slice(0, 8)}`);
      }
    } catch (error) {
      console.error(`[Generation] Operator '${operator}' failed for child ${i}:`, error);
      // Fallback to parent
      prompt = parent.prompt;
      changeLog = [{ label: 'ERROR', text: `Operator '${operator}' failed, using parent` }];
    }
    
    // Parameter variation (temperature) - applied independently
    if (config.operators.paramVariation?.enabled && Math.random() < paramVariationShare) {
      const tempConfig = config.operators.paramVariation.temperature;
      const min = tempConfig.min || 0.3;
      const max = tempConfig.max || 1.5;
      temperature = min + Math.random() * (max - min);
      changeLog.push({ label: 'PARAM', text: `Temperature varied to ${temperature.toFixed(2)}` });
      if (!operatorType) operatorType = 'param';
      console.log(`[Generation] Child ${i}: Temperature varied to ${temperature.toFixed(2)}`);
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

