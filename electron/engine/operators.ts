import type { CandidateNode, ChangeLogLine, EvaluationConfig, ModelRef } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';
import { v4 as uuidv4 } from 'uuid';

// Service model templates
const MUTATION_TEMPLATE = `SYSTEM: You propose SMALL, PRECISE edits to improve a prompt.
USER: Candidate prompt: <<<
{prompt}
>>>
Make 1–3 minimal edits chosen from: structure, content, formatting, compression, regularizers.
Return JSON list of edits: [{"label":"MUTATION","edit":"..."}]`;

const APPLY_EDITS_TEMPLATE = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
{prompt}
>>>
Edits: {edits}
Produce the NEW prompt ONLY.`;

const CROSSOVER_TEMPLATE = `SYSTEM: Merge best parts of A and B into a coherent prompt without redundancy.
USER: A: <<<
{promptA}
>>>
B: <<<
{promptB}
>>>
Return the merged prompt ONLY.`;

const META_TEMPLATE = `SYSTEM: You are a prompt surgeon. Suggest surgical changes based on failures.
USER: Parent Prompt: <<<
{parent}
>>>
Top failures (3): {summary}
Hard constraints: {constraints}
Return JSON edits: [{"label":"META","edit":"..."}]`;

export async function applyMutation(
  parent: CandidateNode,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; totalCost: number; totalPromptTokens: number; totalCompletionTokens: number }> {
  const serviceModel = config.serviceModel;
  const adapter = getProviderAdapter(serviceModel.provider);
  
  console.log(`[Mutation] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  
  // Generate mutation edits
  const mutationPrompt = MUTATION_TEMPLATE.replace('{prompt}', parent.prompt);
  
  try {
    const mutationResult = await adapter.call({
      model: serviceModel.model,
      prompt: mutationPrompt,
      temperature: 0.7,
      maxTokens: 2000,
    });
    
    // Track cost from first call
    totalCost += mutationResult.usd || 0;
    totalPromptTokens += mutationResult.promptTokens || 0;
    totalCompletionTokens += mutationResult.completionTokens || 0;
    
    // Parse edits
    let edits: Array<{ label: string; edit: string }> = [];
    try {
      // Strip markdown code blocks if present
      let jsonText = mutationResult.output.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(jsonText);
      edits = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // If JSON parsing fails, treat the whole response as a single edit
      edits = [{ label: 'MUTATION', edit: mutationResult.output }];
    }
    
    // Apply edits
    const applyPrompt = APPLY_EDITS_TEMPLATE
      .replace('{prompt}', parent.prompt)
      .replace('{edits}', JSON.stringify(edits));
    
    const applyResult = await adapter.call({
      model: serviceModel.model,
      prompt: applyPrompt,
      temperature: 0.3,
      maxTokens: 4096,
    });
    
    // Track cost from second call
    totalCost += applyResult.usd || 0;
    totalPromptTokens += applyResult.promptTokens || 0;
    totalCompletionTokens += applyResult.completionTokens || 0;
    
    const changeLog: ChangeLogLine[] = edits.map(e => ({
      label: 'MUTATION',
      text: e.edit,
    }));
    
    return {
      prompt: applyResult.output.trim(),
      changeLog,
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  } catch (error) {
    console.error('Mutation failed:', error);
    // Fallback: return parent with no changes
    return {
      prompt: parent.prompt,
      changeLog: [{ label: 'MUTATION', text: 'Failed to apply mutation' }],
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  }
}

export async function applyCrossover(
  parentA: CandidateNode,
  parentB: CandidateNode,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; totalCost: number; totalPromptTokens: number; totalCompletionTokens: number }> {
  const serviceModel = config.serviceModel;
  const adapter = getProviderAdapter(serviceModel.provider);
  
  console.log(`[Crossover] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  
  const crossoverPrompt = CROSSOVER_TEMPLATE
    .replace('{promptA}', parentA.prompt)
    .replace('{promptB}', parentB.prompt);
  
  try {
    const result = await adapter.call({
      model: serviceModel.model,
      prompt: crossoverPrompt,
      temperature: 0.5,
      maxTokens: 4096,
    });
    
    // Track cost
    totalCost += result.usd || 0;
    totalPromptTokens += result.promptTokens || 0;
    totalCompletionTokens += result.completionTokens || 0;
    
    return {
      prompt: result.output.trim(),
      changeLog: [
        {
          label: 'CROSSOVER',
          text: `Merged prompts from ${parentA.id.substring(0, 8)} and ${parentB.id.substring(0, 8)}`,
        },
      ],
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  } catch (error) {
    console.error('Crossover failed:', error);
    // Fallback: return parentA
    return {
      prompt: parentA.prompt,
      changeLog: [{ label: 'CROSSOVER', text: 'Failed to apply crossover' }],
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  }
}

export async function applyMetaPrompting(
  parent: CandidateNode,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; totalCost: number; totalPromptTokens: number; totalCompletionTokens: number }> {
  const serviceModel = config.serviceModel;
  const adapter = getProviderAdapter(serviceModel.provider);
  
  console.log(`[Meta-prompting] Using service model: ${serviceModel.provider}/${serviceModel.model}`);
  
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  
  // Collect failure summary
  const failedTests = parent.tests?.filter(t => !t.passed) ?? [];
  const summary = failedTests
    .slice(0, 3)
    .map(t => `Test ${t.testId}: score ${t.score}/10`)
    .join('; ');
  
  const metaPrompt = META_TEMPLATE
    .replace('{parent}', parent.prompt)
    .replace('{summary}', summary || 'No specific failures')
    .replace('{constraints}', 'Maintain core structure and intent');
  
  try {
    const metaResult = await adapter.call({
      model: serviceModel.model,
      prompt: metaPrompt,
      temperature: 0.7,
      maxTokens: 2000,
    });
    
    // Track cost from first call
    totalCost += metaResult.usd || 0;
    totalPromptTokens += metaResult.promptTokens || 0;
    totalCompletionTokens += metaResult.completionTokens || 0;
    
    // Parse edits
    let edits: Array<{ label: string; edit: string }> = [];
    try {
      // Strip markdown code blocks if present
      let jsonText = metaResult.output.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(jsonText);
      edits = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      edits = [{ label: 'META', edit: metaResult.output }];
    }
    
    // Apply edits
    const applyPrompt = APPLY_EDITS_TEMPLATE
      .replace('{prompt}', parent.prompt)
      .replace('{edits}', JSON.stringify(edits));
    
    const applyResult = await adapter.call({
      model: serviceModel.model,
      prompt: applyPrompt,
      temperature: 0.3,
      maxTokens: 4096,
    });
    
    // Track cost from second call
    totalCost += applyResult.usd || 0;
    totalPromptTokens += applyResult.promptTokens || 0;
    totalCompletionTokens += applyResult.completionTokens || 0;
    
    const changeLog: ChangeLogLine[] = edits.map(e => ({
      label: 'META',
      text: e.edit,
    }));
    
    return {
      prompt: applyResult.output.trim(),
      changeLog,
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  } catch (error) {
    console.error('Meta-prompting failed:', error);
    return {
      prompt: parent.prompt,
      changeLog: [{ label: 'META', text: 'Failed to apply meta-prompting' }],
      totalCost,
      totalPromptTokens,
      totalCompletionTokens,
    };
  }
}

export function applyParameterVariation(
  parent: CandidateNode,
  config: EvaluationConfig
): { params: any; changeLog: ChangeLogLine[] } {
  const paramVariation = config.operators.paramVariation;
  if (!paramVariation?.enabled) {
    return { params: parent.params, changeLog: [] };
  }
  
  // Vary temperature within bounds
  const { min, max } = paramVariation.temperature;
  const newTemp = min + Math.random() * (max - min);
  
  return {
    params: {
      ...parent.params,
      temperature: Math.round(newTemp * 100) / 100,
    },
    changeLog: [
      {
        label: 'PARAM',
        text: `Temperature: ${parent.params.temperature} → ${Math.round(newTemp * 100) / 100}`,
      },
    ],
  };
}

export function selectModelsForOffspring(config: EvaluationConfig): ModelRef[] {
  // Randomly select from enabled models
  return config.enabledModels;
}

export async function generateInitialPopulation(
  config: EvaluationConfig
): Promise<CandidateNode[]> {
  const nodes: CandidateNode[] = [];
  
  if (config.population.fill === 'manual') {
    // User-specified prompts
    const manualPrompts = (config.population as any).manualPrompts || [];
    
    if (manualPrompts.length === 0) {
      throw new Error('Manual mode requires at least one prompt');
    }
    
    // Create a node for each manual prompt
    for (let i = 0; i < manualPrompts.length; i++) {
      const item = manualPrompts[i];
      if (!item.prompt || !item.model) {
        throw new Error(`Manual prompt #${i + 1} is incomplete`);
      }
      
      const node: CandidateNode = {
        id: uuidv4(),
        generation: 0,
        lineageParents: [],
        status: 'awaiting',
        prompt: item.prompt,
        params: {
          model: item.model,
          temperature: 0.7, // Default temperature
        },
        changeLog: [{
          label: 'initial',
          description: `Manual prompt #${i + 1}`,
        }],
      };
      nodes.push(node);
    }
  } else {
    // Auto-fill via mutations from seed
    const seedPrompt = config.population.seedPrompt;
    
    if (!seedPrompt) {
      throw new Error('Seed prompt is required for auto mode');
    }
    
    // First node is the seed
    nodes.push(createInitialNode(seedPrompt, config.enabledModels[0], 0));
    
    // Generate variations
    for (let i = 1; i < config.population.size; i++) {
      const model = config.enabledModels[i % config.enabledModels.length];
      
      if (i === 1) {
        // Just add seed with different model
        nodes.push(createInitialNode(seedPrompt, model, i));
      } else {
        // Create mutations of the seed
        try {
          const mutated = await applyMutation(nodes[0], config);
          const node = createInitialNode(mutated.prompt, model, i);
          node.changeLog = mutated.changeLog;
          nodes.push(node);
        } catch {
          // Fallback to seed
          nodes.push(createInitialNode(seedPrompt, model, i));
        }
      }
    }
  }
  
  return nodes;
}

function createInitialNode(
  prompt: string,
  model: ModelRef,
  index: number
): CandidateNode {
  return {
    id: uuidv4(),
    generation: 0,
    lineageParents: [],
    status: 'awaiting',
    prompt,
    params: {
      model,
      temperature: 0.7,
    },
    changeLog: [],
  };
}

