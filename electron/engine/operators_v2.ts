/**
 * Genetic Operators - V2 Complete Rewrite
 * 
 * Clean separation:
 * - createShellPopulation: Creates initial node shells (synchronous, fast)
 * 
 * Note: Basic mutation moved to mutations.ts
 * Note: Crossover moved to crossover.ts
 * Note: Meta-prompting moved to metaprompting.ts
 * Note: Parameter variation moved to paramvariation.ts
 */

import { v4 as uuidv4 } from 'uuid';
import type { CandidateNode, EvaluationConfig, ModelRef, ChangeLogLine } from '../../src/types/index.js';
export { mutateNode } from './mutations.js';
export { crossoverNodes } from './crossover.js';
export { metaPromptNode } from './metaprompting.js';
export { varyParameters, shouldApplyParamVariation, getDefaultTemperature } from './paramvariation.js';

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
