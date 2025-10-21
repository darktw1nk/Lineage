/**
 * Genetic Operators - V2 Complete Rewrite
 * 
 * Clean separation:
 * - createShellPopulation: Creates initial node shells (synchronous, fast)
 * - mutateNode: Mutates a single node (async, slow)
 * - Caller handles streaming updates to UI
 */

import { v4 as uuidv4 } from 'uuid';
import type { CandidateNode, EvaluationConfig, ModelRef, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';

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
 * Mutates a single node using service model
 * Returns new prompt and changelog
 */
export async function mutateNode(
  basePrompt: string,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[] }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  try {
    // Step 1: Propose edits
    const proposalPrompt = `SYSTEM: You propose SMALL, PRECISE edits to improve a prompt.
USER: Candidate prompt: <<<
${basePrompt}
>>>
Make 1–3 minimal edits chosen from: structure, content, formatting, compression, regularizers.
Return JSON list of edits: [{"label":"MUTATION","edit":"..."}]`;
    
    const proposalResult = await serviceAdapter.call({
      model: config.serviceModel.model,
      prompt: proposalPrompt,
      temperature: 1.0,
      maxTokens,
    });
    
    if (!proposalResult.output || proposalResult.output.trim() === '') {
      throw new Error('Empty response from service model (proposal step)');
    }
    
    // Parse edits
    let edits: any[];
    try {
      const cleaned = proposalResult.output.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      edits = JSON.parse(cleaned);
    } catch {
      throw new Error('Failed to parse edit proposals as JSON');
    }
    
    // Step 2: Apply edits
    const applyPrompt = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
${basePrompt}
>>>
Edits: ${JSON.stringify(edits)}
Produce the NEW prompt ONLY.`;
    
    const applyResult = await serviceAdapter.call({
      model: config.serviceModel.model,
      prompt: applyPrompt,
      temperature: 0.3,
      maxTokens,
    });
    
    if (!applyResult.output || applyResult.output.trim() === '') {
      throw new Error('Empty response from service model (apply step)');
    }
    
    const newPrompt = applyResult.output.trim();
    
    // Build changelog
    const changeLog: ChangeLogLine[] = edits.map(e => ({
      label: 'MUTATION' as const,
      text: e.edit || 'Unknown edit',
    }));
    
    return { prompt: newPrompt, changeLog };
  } catch (error) {
    console.error('[Mutation] Failed:', error);
    throw error;
  }
}

/**
 * Crossover between two parents
 */
export async function crossoverNodes(
  parentA: CandidateNode,
  parentB: CandidateNode,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[] }> {
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
  };
}

/**
 * Meta-prompting: targeted edits based on failures
 */
export async function metaPromptNode(
  parent: CandidateNode,
  failures: string[],
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[] }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  const metaPrompt = `SYSTEM: You are a prompt surgeon. Suggest surgical changes based on failures.
USER: Parent Prompt: <<<
${parent.prompt}
>>>
Top failures: ${failures.join(', ')}
Return JSON edits: [{"label":"META","edit":"..."}]`;
  
  const proposalResult = await serviceAdapter.call({
    model: config.serviceModel.model,
    prompt: metaPrompt,
    temperature: 0.8,
    maxTokens,
  });
  
  if (!proposalResult.output || proposalResult.output.trim() === '') {
    throw new Error('Empty response from meta-prompting');
  }
  
  let edits: any[];
  try {
    const cleaned = proposalResult.output.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    edits = JSON.parse(cleaned);
  } catch {
    throw new Error('Failed to parse meta-prompt edits');
  }
  
  // Apply edits
  const applyPrompt = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
${parent.prompt}
>>>
Edits: ${JSON.stringify(edits)}
Produce the NEW prompt ONLY.`;
  
  const applyResult = await serviceAdapter.call({
    model: config.serviceModel.model,
    prompt: applyPrompt,
    temperature: 0.3,
    maxTokens,
  });
  
  if (!applyResult.output || applyResult.output.trim() === '') {
    throw new Error('Empty response from meta-prompt apply');
  }
  
  return {
    prompt: applyResult.output.trim(),
    changeLog: edits.map(e => ({
      label: 'META' as const,
      text: e.edit || 'Unknown meta-edit',
    })),
  };
}

