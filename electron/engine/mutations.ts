/**
 * Mutation Operations
 * 
 * Handles prompt mutation using LLM-based edit proposals and application
 * Includes retry logic for JSON parsing failures with cost tracking
 */

import type { EvaluationConfig, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';

/**
 * Default Mutation Strategy Catalog
 * Specific, actionable mutation techniques organized by category
 */
const DEFAULT_MUTATION_STRATEGIES = {
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

const DEFAULT_PROPOSAL_PROMPT = `SYSTEM: You will get a prompt from a user, 
  propose SMALL, PRECISE mutations to improve a prompt based on strategies below.

Apply these specific mutation strategies:
\${strategiesList}
  
For each strategy above, propose a concrete edit. 

Return JSON list with the category prefix preserved:
[{"label":"MUTATION","edit":"[Category] Specific change description"}]
Always answer in JSON format, not simple text, json. 
IMPORTANT: Keep the [Category] prefix from each strategy in your edit descriptions. 
  
USER: Candidate prompt: <<<
\${basePrompt}
>>>`;

const DEFAULT_APPLY_PROMPT = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${basePrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`;

/**
 * Load mutation strategies from storage or use defaults
 */
function getMutationStrategies(): Record<string, string[]> {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.mutationStrategies) {
      return JSON.parse(prompts.mutationStrategies);
    }
  } catch (error) {
    console.error('[Mutations] Failed to load custom strategies, using defaults:', error);
  }
  return DEFAULT_MUTATION_STRATEGIES;
}

/**
 * Load proposal prompt template from storage or use default
 */
function getProposalPromptTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.mutationProposalPrompt) {
      return prompts.mutationProposalPrompt;
    }
  } catch (error) {
    console.error('[Mutations] Failed to load custom proposal prompt, using default:', error);
  }
  return DEFAULT_PROPOSAL_PROMPT;
}

/**
 * Load apply prompt template from storage or use default
 */
function getApplyPromptTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.mutationApplyPrompt) {
      return prompts.mutationApplyPrompt;
    }
  } catch (error) {
    console.error('[Mutations] Failed to load custom apply prompt, using default:', error);
  }
  return DEFAULT_APPLY_PROMPT;
}

/**
 * Randomly select N mutation strategies from the catalog
 * Returns strategies with category prefix: "[Category] Strategy description"
 */
function selectRandomStrategies(count: number = 2): string[] {
  const MUTATION_STRATEGIES = getMutationStrategies();
  const allStrategies: Array<{ category: string; strategy: string }> = [];
  
  // Flatten all strategies with their categories
  for (const category of Object.keys(MUTATION_STRATEGIES)) {
    const strategies = MUTATION_STRATEGIES[category];
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
  const maxRetries = config.retries ?? 3;
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Select 1-3 random mutation strategies (once, reused across retries)
  const numStrategies = Math.floor(Math.random() * 3) + 1;
  const selectedStrategies = selectRandomStrategies(numStrategies);
  console.log(`[Mutation] Selected ${numStrategies} strategies:`, selectedStrategies);
  
  const strategiesList = selectedStrategies.map((s, i) => `${i + 1}. ${s}`).join('\n');
  
  // Load proposal prompt template and substitute variables
  const proposalPromptTemplate = getProposalPromptTemplate();
  const proposalPrompt = proposalPromptTemplate
    .replace(/\$\{strategiesList\}/g, strategiesList)
    .replace(/\$\{basePrompt\}/g, basePrompt);

  // Step 1: Propose edits with retry for JSON parsing
  let edits: any[];
  let lastProposalError: Error | undefined;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[Mutation] Retry attempt ${attempt + 1}/${maxRetries} for proposal step`);
      }
      
      const proposalResult = await serviceAdapter.call({
        model: config.serviceModel.model,
        prompt: proposalPrompt,
        temperature: 1.0,
        maxTokens,
      });
      
      // ALWAYS track costs, even if parsing fails later
      totalPromptTokens += proposalResult.promptTokens;
      totalCompletionTokens += proposalResult.completionTokens;
      totalUsd += proposalResult.usd;
      totalCalls++;
      
      console.log(`[Mutation] Proposal attempt ${attempt + 1} cost: $${proposalResult.usd.toFixed(6)}`);
      
      if (!proposalResult.output || proposalResult.output.trim() === '') {
        throw new Error('Empty response from service model (proposal step)');
      }
      
      // Try to parse JSON
      const cleaned = proposalResult.output.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      edits = JSON.parse(cleaned);
      console.log(`[Mutation] Successfully parsed edits on attempt ${attempt + 1}:`, edits);
      
      // Success! Break out of retry loop
      break;
    } catch (error) {
      lastProposalError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Mutation] Proposal attempt ${attempt + 1} failed:`, error);
      
      // If this was the last attempt, throw
      if (attempt === maxRetries - 1) {
        console.error(`[Mutation] All ${maxRetries} proposal attempts failed. Total cost: $${totalUsd.toFixed(6)}`);
        throw lastProposalError;
      }
      
      // Wait before retry (exponential backoff)
     // const waitMs = Math.min(500 * Math.pow(2, attempt), 5000);
     // console.log(`[Mutation] Waiting ${waitMs}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Step 2: Apply edits (no retry needed here, simpler operation)
  const applyPromptTemplate = getApplyPromptTemplate();
  const applyPrompt = applyPromptTemplate
    .replace(/\$\{basePrompt\}/g, basePrompt)
    .replace(/\$\{edits\}/g, JSON.stringify(edits));
  
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
  const changeLog: ChangeLogLine[] = edits!.map(e => ({
    label: 'MUTATION' as const,
    text: e.edit || 'Unknown edit',
  }));
  
  console.log(`[Mutation] Success! Total cost: $${totalUsd.toFixed(6)}, ${totalCalls} calls`);
  
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
}

