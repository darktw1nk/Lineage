/**
 * Genetic Operators - V2 Complete Rewrite
 * 
 * Clean separation:
 * - createShellPopulation: Creates initial node shells (synchronous, fast)
 * - crossoverNodes: Combines two parent nodes
 * 
 * Note: Basic mutation moved to mutations.ts
 * Note: Meta-prompting moved to metaprompting.ts
 */

import { v4 as uuidv4 } from 'uuid';
import type { CandidateNode, EvaluationConfig, ModelRef, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';
export { mutateNode } from './mutations.js';
export { metaPromptNode } from './metaprompting.js';

/**
 * Creates shell nodes for initial population
 * ALL nodes use seed prompt initially
 * Node #0 stays as seed (baseline)
 * Nodes #1+ will be mutated by caller
 */
export function createShellPopulation(config: EvaluationConfig): CandidateNode[] {
  if (config.population.fill === 'manual') {
    return createManualPopulation(config);
  } else {
    return createAutoShellNodes(config);
  }
}

function createManualPopulation(config: EvaluationConfig): CandidateNode[] {
  const manualPrompts = (config.population as any).manualPrompts || [];
  if (manualPrompts.length === 0) {
    throw new Error('Manual mode requires at least one prompt');
  }
  
  return manualPrompts.map((item: any, index: number) => {
    if (!item.prompt || !item.model) {
      throw new Error(`Manual prompt #${index + 1} is incomplete`);
    }
    
    return {
      id: uuidv4(),
      generation: 0,
      lineageParents: [],
      status: 'awaiting' as const,
      prompt: item.prompt,
      params: {
        model: item.model,
        temperature: 0.7,
      },
      changeLog: [{
        label: 'MUTATION' as const,
        text: `Manual prompt #${index + 1}`,
      }],
    };
  });
}

function createAutoShellNodes(config: EvaluationConfig): CandidateNode[] {
  const seedPrompt = config.population.seedPrompt;
  if (!seedPrompt) {
    throw new Error('Seed prompt is required for auto mode');
  }
  
  const nodes: CandidateNode[] = [];
  
  for (let i = 0; i < config.population.size; i++) {
    const model = config.enabledModels[i % config.enabledModels.length];
    
    const node: CandidateNode = {
      id: uuidv4(),
      generation: 0,
      lineageParents: [],
      status: i === 0 ? 'awaiting' : 'pending',
      prompt: seedPrompt,
      params: {
        model,
        temperature: 0.7,
      },
      changeLog: i === 0
        ? [{ label: 'MUTATION' as const, text: 'Seed prompt (baseline)' }]
        : [{ label: 'MUTATION' as const, text: 'Waiting for mutation...' }],
    };
    
    nodes.push(node);
  }
  
  return nodes;
}

/**
 * Crossover between two parents
 */
export async function crossoverNodes(
  parentA: CandidateNode,
  parentB: CandidateNode,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  const crossoverPrompt = `SYSTEM: Merge best parts of A and B into a coherent prompt without redundancy.
USER: A: <<<
${parentA.prompt}
>>>
B: <<<
${parentB.prompt}
>>>
Return the merged prompt ONLY.`;
  
  const result = await serviceAdapter.call({
    model: config.serviceModel.model,
    prompt: crossoverPrompt,
    temperature: 0.7,
    maxTokens,
  });
  
  if (!result.output || result.output.trim() === '') {
    throw new Error('Empty response from crossover');
  }
  
  return {
    prompt: result.output.trim(),
    changeLog: [{
      label: 'CROSSOVER' as const,
      text: `Merged ${parentA.id.slice(0, 8)} + ${parentB.id.slice(0, 8)}`,
    }],
    cost: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      usd: result.usd,
      calls: 1,
    },
  };
}
