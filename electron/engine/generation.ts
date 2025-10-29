/**
 * Generation Creation and Selection
 * 
 * Handles:
 * - Selection (Top-K, Top-P)
 * - Fair weighted distribution: better parents get more children proportional to rank
 * - Fixed population size: each generation has exactly the same number of nodes
 * - Guaranteed participation: when Y >= N, every parent gets at least 1 child
 * - Genetic operators (mutation, crossover, meta-prompting, carry-forward)
 * - Parameter variation (temperature)
 * - Proper lineage tracking (crossover tracks BOTH parents)
 * 
 * Parent Assignment Algorithm:
 * 1. Select top X performers (Top-K or Top-P)
 * 2. Calculate rank weights: best=X, 2nd=X-1, ..., worst=1
 * 3. If Y >= X: seed 1 child per parent, then distribute remaining (Y-X) proportionally
 *    If Y < X: distribute all Y children proportionally (some parents may get 0)
 * 4. Use largest-remainder method to handle fractional allocations
 * 5. Shuffle assignments for randomness while preserving counts
 * 
 * Operator Assignment Algorithm:
 * 1. Calculate exact operator counts from shares (mutation, crossover, meta, carry)
 * 2. Shuffle operator assignments independently from parents
 * 3. Create exactly Y children, each with assigned (parent, operator, model, temperature)
 * 
 * Example (3 parents, 10 children):
 *   Seed: P1=1, P2=1, P3=1 (total=3)
 *   Remaining: 7 children
 *   Weights: [3, 2, 1] → total=6
 *   Quotas: P1=3.5, P2=2.33, P3=1.17
 *   Floors: P1=3, P2=2, P3=1 (total=6)
 *   Remainders: P1=0.5, P2=0.33, P3=0.17 → P1 gets +1
 *   Final: P1=1+3+1=5, P2=1+2=3, P3=1+1=2 ✅ (total=10, all participate)
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
  config: EvaluationConfig
): Promise<GenerationResult> {
  const newGenNodes: CandidateNode[] = [];
  
  // Determine target population size (same as current generation)
  const targetPopSize = currentGeneration.length;
  console.log(`[Generation] Creating ${targetPopSize} children from ${topPerformers.length} parents`);
  
  // Operator shares
  const mutationFactor = config.operators.mutationFactor;
  const crossoverFactor = config.operators.crossoverFactor;
  const metaPromptShare = config.operators.metaPrompting?.enabled 
    ? (config.operators.metaPrompting.share || 0.2) 
    : 0;
  const paramVariationShare = config.operators.paramVariation?.enabled 
    ? (config.operators.paramVariation.share || 0.2) 
    : 0;
  
  // Calculate operator counts
  let numMeta = Math.round(targetPopSize * metaPromptShare);
  let numCrossover = Math.round(targetPopSize * crossoverFactor);
  let numMutation = Math.round(targetPopSize * mutationFactor);
  
  // Remaining go to carry-forward
  let numCarryForward = targetPopSize - numMeta - numCrossover - numMutation;
  
  // Fix remainders to ensure exact count
  while (numMeta + numCrossover + numMutation + numCarryForward < targetPopSize) {
    numMutation++; // Favor mutation for remainder
  }
  while (numMeta + numCrossover + numMutation + numCarryForward > targetPopSize) {
    if (numCarryForward > 0) numCarryForward--;
    else if (numMutation > 0) numMutation--;
    else if (numCrossover > 0) numCrossover--;
    else numMeta--;
  }
  
  console.log(`[Generation] Operator counts: meta=${numMeta}, crossover=${numCrossover}, mutation=${numMutation}, carry=${numCarryForward}`);
  
  // Assign parents to children with fair weighted distribution
  const parentAssignments = assignParentsToChildren(topPerformers, targetPopSize);
  
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
  
  // Create children
  for (let i = 0; i < targetPopSize; i++) {
    const parent = parentAssignments[i]; // Direct assignment, no need for modulo
    const model = config.enabledModels[i % config.enabledModels.length];
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

