/**
 * Generation Creation and Selection
 * 
 * Handles:
 * - Selection (Top-K, Top-P)
 * - Genetic operators (mutation, crossover, meta-prompting, carry-forward)
 * - Parameter variation (temperature)
 * - New node creation
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
 * Create next generation from top performers
 */
export async function createNextGeneration(
  topPerformers: CandidateNode[],
  currentGeneration: CandidateNode[],
  nextGenerationNumber: number,
  config: EvaluationConfig
): Promise<GenerationResult> {
  const newGenNodes: CandidateNode[] = [];
  const mutationFactor = config.operators.mutationFactor;
  const crossoverFactor = config.operators.crossoverFactor;
  
  // Variation shares
  const metaPromptShare = config.operators.metaPrompting?.enabled 
    ? (config.operators.metaPrompting.share || 0.2) 
    : 0;
  const paramVariationShare = config.operators.paramVariation?.enabled 
    ? (config.operators.paramVariation.share || 0.2) 
    : 0;
  
  // Cost tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  for (let i = 0; i < topPerformers.length; i++) {
    const parent = topPerformers[i];
    const model = config.enabledModels[i % config.enabledModels.length];
    const parentFitness = parent.metrics?.fitness || 0;
    
    let prompt = parent.prompt;
    let changeLog: ChangeLogLine[] = [];
    let temperature = 0.7; // Default
    let operatorType: 'mutation' | 'crossover' | 'meta' | 'param' | null = null;
    
    const rand = Math.random();
    
    try {
      if (rand < metaPromptShare && config.operators.metaPrompting?.enabled) {
        // Meta-prompting (targeted edits based on failures or general improvements)
        const result = await metaPromptNode(parent, config, currentGeneration);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'meta';
        
        // Track costs
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Meta-prompting for gen ${nextGenerationNumber} node ${i}`);
      } else if (rand < metaPromptShare + crossoverFactor && topPerformers.length > 1) {
        // Crossover
        const parentB = topPerformers[Math.floor(Math.random() * topPerformers.length)];
        const result = await crossoverNodes(parent, parentB, config);
        prompt = result.prompt;
        changeLog = result.changeLog;
        operatorType = 'crossover';
        
        // Track costs
        totalPromptTokens += result.cost.promptTokens;
        totalCompletionTokens += result.cost.completionTokens;
        totalUsd += result.cost.usd;
        totalCalls += result.cost.calls;
        
        console.log(`[Generation] Crossover for gen ${nextGenerationNumber} node ${i}`);
      } else if (rand < metaPromptShare + crossoverFactor + mutationFactor) {
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
        
        console.log(`[Generation] Mutation for gen ${nextGenerationNumber} node ${i}`);
      } else {
        // Carry forward
        changeLog = [{ label: 'MUTATION', text: 'Carried forward (no variation)' }];
        console.log(`[Generation] Carry forward for gen ${nextGenerationNumber} node ${i}`);
      }
    } catch (error) {
      console.error(`[Generation] Operator failed for gen ${nextGenerationNumber} node ${i}:`, error);
      // Fallback to parent
      prompt = parent.prompt;
      changeLog = [{ label: 'MUTATION', text: 'Operator failed, using parent' }];
    }
    
    // Parameter variation (temperature)
    if (config.operators.paramVariation?.enabled && Math.random() < paramVariationShare) {
      const tempConfig = config.operators.paramVariation.temperature;
      const min = tempConfig.min || 0.3;
      const max = tempConfig.max || 1.5;
      temperature = min + Math.random() * (max - min);
      changeLog.push({ label: 'PARAM', text: `Temperature varied to ${temperature.toFixed(2)}` });
      if (!operatorType) operatorType = 'param';
      console.log(`[Generation] Parameter variation for gen ${nextGenerationNumber} node ${i}: temp=${temperature.toFixed(2)}`);
    }
    
    const newNode: CandidateNode = {
      id: uuidv4(),
      generation: nextGenerationNumber,
      lineageParents: [parent.id],
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
  
  console.log(`[Generation] Created ${newGenNodes.length} nodes for generation ${nextGenerationNumber}`);
  
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

