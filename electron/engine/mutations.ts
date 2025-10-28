/**
 * Mutation Operations
 * 
 * Handles prompt mutation using LLM-based edit proposals and application
 */

import type { EvaluationConfig, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';

/**
 * Mutation Strategy Catalog
 * Specific, actionable mutation techniques organized by category
 */
const MUTATION_STRATEGIES = {
  structure: [
    'Reorder sections (role → goals → constraints → output spec)',
    'Convert paragraphs to bullet checklists',
    'Insert a thinking scaffold (e.g., "First, extract actors… Then, dedupe…")',
  ],
  content: [
    'Tighten constraints ("Output strictly RFC8259 JSON. No commentary.")',
    'Add/replace few-shot examples (hard cases, counter-examples)',
    'Add evaluation rubric inside the prompt ("If a task lacks an assignee, infer from speaker attribution.")',
    'Add anti-patterns ("Do not create subtasks for \'thanks\', \'OK\' ")',
    'Introduce domain terms/ontologies',
  ],
  formatting: [
    'Switch from free text → step-tagged blocks (e.g., # PLAN, # FINAL)',
    'Adjust temperature/tool-use hints',
  ],
  compression: [
    'Replace long rules with short checklists or regex-like constraints',
    'Prune redundant lines detected via ablation',
  ],
  regularizers: [
    'Add length constraints (tokens/words)',
    'Force field-by-field validation hints (e.g., JSON schema embedded)',
  ],
};

/**
 * Randomly select N mutation strategies from the catalog
 * Returns strategies with category prefix: "[Category] Strategy description"
 */
function selectRandomStrategies(count: number = 2): string[] {
  const allStrategies: Array<{ category: string; strategy: string }> = [];
  
  // Flatten all strategies with their categories
  for (const category of Object.keys(MUTATION_STRATEGIES)) {
    const strategies = MUTATION_STRATEGIES[category as keyof typeof MUTATION_STRATEGIES];
    for (const strategy of strategies) {
      allStrategies.push({
        category: category.charAt(0).toUpperCase() + category.slice(1), // Capitalize first letter
        strategy,
      });
    }
  }
  
  // Shuffle and select N strategies
  const shuffled = allStrategies.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, allStrategies.length));
  
  // Format with category prefix
  return selected.map(s => `[${s.category}] ${s.strategy}`);
}

/**
 * Mutates a single prompt using service model
 * Returns new prompt and changelog
 * 
 * Two-step process:
 * 1. Propose edits (creative, temp=1.0)
 * 2. Apply edits (precise, temp=0.3)
 */
export async function mutateNode(
  basePrompt: string,
  config: EvaluationConfig
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  try {
    // Select 1-3 random mutation strategies
    const numStrategies = Math.floor(Math.random() * 3) + 1; // 1-3 strategies
    const selectedStrategies = selectRandomStrategies(numStrategies);
    
    console.log(`[Mutation] Selected ${numStrategies} strategies:`, selectedStrategies);
    
    // Step 1: Propose edits using selected strategies
    const strategiesList = selectedStrategies.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const proposalPrompt = `SYSTEM: You propose SMALL, PRECISE edits to improve a prompt.
USER: Candidate prompt: <<<
${basePrompt}
>>>
Apply these specific mutation strategies:
${strategiesList}

For each strategy above, propose a concrete edit. Return JSON list with the category prefix preserved:
[{"label":"MUTATION","edit":"[Category] Specific change description"}]

IMPORTANT: Keep the [Category] prefix from each strategy in your edit descriptions.`;
    
    const proposalResult = await serviceAdapter.call({
      model: config.serviceModel.model,
      prompt: proposalPrompt,
      temperature: 1.0,
      maxTokens,
    });
    
    totalPromptTokens += proposalResult.promptTokens;
    totalCompletionTokens += proposalResult.completionTokens;
    totalUsd += proposalResult.usd;
    totalCalls++;
    
    if (!proposalResult.output || proposalResult.output.trim() === '') {
      throw new Error('Empty response from service model (proposal step)');
    }
    
    // Parse edits
    let edits: any[];
    try {
      const cleaned = proposalResult.output.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      console.log(`[Mutation] Raw output:`, proposalResult.output);
      console.log(`[Mutation] Cleaned output:`, cleaned);
      edits = JSON.parse(cleaned);
      console.log(`[Mutation] Parsed edits:`, edits);
    } catch (error) {
      console.error(`[Mutation] Parse error:`, error);
      console.error(`[Mutation] Failed to parse:`, proposalResult.output);
      throw new Error(`Failed to parse edit proposals as JSON: ${error instanceof Error ? error.message : String(error)}`);
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
    
    totalPromptTokens += applyResult.promptTokens;
    totalCompletionTokens += applyResult.completionTokens;
    totalUsd += applyResult.usd;
    totalCalls++;
    
    if (!applyResult.output || applyResult.output.trim() === '') {
      throw new Error('Empty response from service model (apply step)');
    }
    
    const newPrompt = applyResult.output.trim();
    
    // Build changelog
    const changeLog: ChangeLogLine[] = edits.map(e => ({
      label: 'MUTATION' as const,
      text: e.edit || 'Unknown edit',
    }));
    
    return {
      prompt: newPrompt,
      changeLog,
      cost: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        usd: totalUsd,
        calls: totalCalls,
      },
    };
  } catch (error) {
    console.error('[Mutation] Failed:', error);
    throw error;
  }
}

