/**
 * Mutation Operations
 * 
 * Handles prompt mutation using LLM-based edit proposals and application
 * Includes retry logic for JSON parsing failures with cost tracking
 */

import type { EvaluationConfig, ChangeLogLine } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';
import { stripPromptDelimiters, extractJsonArray, fillTemplate, sanitizeForJudge, appliedPromptProblem } from '../utils/text.js';
import type { AppliedPromptProblem } from '../utils/text.js';
import { withPartialCost } from './operator-cost.js';

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
  removal: [
    'Identify and REMOVE instructions that may be counterproductive or conflict with the intended task',
    'Delete vague/ambiguous lines that could be misinterpreted by the model',
    'Remove overly cautious constraints that prevent the model from making necessary changes',
  ],
  rewrite: [
    'Rewrite the role/identity statement to better align with the actual task requirements',
    'Replace a passive/vague instruction with a specific, actionable one',
  ],
};

const DEFAULT_PROPOSAL_PROMPT = `SYSTEM: You propose mutations to improve a prompt. The prompt you receive may be partially effective, ineffective, or even counterproductive — do NOT assume it is good. You can ADD, REMOVE, REWRITE, or RESTRUCTURE any part of it.

Apply these specific mutation strategies:
\${strategiesList}

For each strategy above, propose a concrete edit. Edits can include REMOVING lines that hurt performance, not just adding new ones.

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
function selectRandomStrategies(count: number = 2, rng: () => number = Math.random): string[] {
  const MUTATION_STRATEGIES = getMutationStrategies();
  const allStrategies: Array<{ category: string; strategy: string }> = [];
  
  // Flatten all strategies with their categories
  for (const category of Object.keys(MUTATION_STRATEGIES)) {
    const strategies = MUTATION_STRATEGIES[category];
    // A category mapped to a STRING instead of an array iterates by character,
    // so `{"structure": "Reorder the sections"}` in systemPrompts produced
    // eighteen one-letter "strategies". Skip and say so.
    if (!Array.isArray(strategies)) {
      console.warn(
        `[Mutation] systemPrompts.mutationStrategies."${category}" must be an array of strings — ignoring it ` +
        `(got ${typeof strategies}).`,
      );
      continue;
    }
    for (const strategy of strategies) {
      if (typeof strategy !== 'string' || !strategy.trim()) continue;
      allStrategies.push({
        category: category.charAt(0).toUpperCase() + category.slice(1), // Capitalize first letter
        strategy,
      });
    }
  }
  
  // Fisher-Yates shuffle (the old sort(() => Math.random()-0.5) was biased), then select N
  const shuffled = [...allStrategies];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
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
  config: EvaluationConfig,
  rng: () => number = Math.random,
  // Checked between billed calls with THIS operator's unsettled spend — the
  // caller's budget gate only runs before the first call, so without this a
  // mutation bills its whole 2×retries ceiling past the cap (pass 19).
  shouldAbort?: (spentSoFarUSD?: number) => boolean,
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  // At least one attempt: retries: 0 made the proposal loop body never run, so
  // the apply step billed a call for a prompt reading "Edits: undefined" and
  // then threw a TypeError on edits.map.
  const maxRetries = Math.max(1, config.retries ?? 3);
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;

  try {

  // Select 1-3 random mutation strategies (once, reused across retries)
  const numStrategies = Math.floor(rng() * 3) + 1;
  const selectedStrategies = selectRandomStrategies(numStrategies, rng);
  console.log(`[Mutation] Selected ${numStrategies} strategies:`, selectedStrategies);
  
  const strategiesList = selectedStrategies.map((s, i) => `${i + 1}. ${s}`).join('\n');
  
  // Load proposal prompt template and substitute variables
  const proposalPromptTemplate = getProposalPromptTemplate();
  const proposalPrompt = fillTemplate(proposalPromptTemplate, { strategiesList, basePrompt: sanitizeForJudge(basePrompt) });

  // Step 1: Propose edits with retry for JSON parsing
  let edits!: any[];
  let lastProposalError: Error | undefined;
  
  // Carrying the parent is the budget-abort outcome for BOTH loops: the parent
  // is a valid prompt, the changelog is honest, and the caller (which treats a
  // thrown error as a failed node in the gen-0 fill) keeps its slot.
  const budgetCarry = (phase: string) => ({
    prompt: basePrompt,
    changeLog: [{
      label: 'CARRY' as const,
      text: `Budget exhausted during ${phase} — carried the parent unchanged`,
    }],
    cost: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    },
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[Mutation] Retry attempt ${attempt + 1}/${maxRetries} for proposal step`);
        if (shouldAbort?.(totalUsd)) {
          console.warn('[Mutation] Budget exhausted mid-proposal — carrying the parent');
          return budgetCarry('the mutation proposal');
        }
      }
      
      const proposalResult = await serviceAdapter.call({
        model: config.serviceModel.model,
        prompt: proposalPrompt,
        temperature: 1.0,
        maxTokens,
        timeoutMs: config.callTimeoutMs,
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
      
      // Try to parse JSON (tolerates fences and surrounding prose)
      edits = extractJsonArray(proposalResult.output);
      // The SHAPE was never checked, only that it parsed as an array. A model
      // returning `["tighten", "add examples"]` produced a changelog of
      // "Unknown edit" entries, and `[null, null]` threw a raw TypeError out
      // of mutateNode. Treat a wrong shape as an unparseable response so the
      // existing retry loop re-prompts for the documented format.
      if (!edits.every(e => e && typeof e === 'object' && typeof (e as any).edit === 'string')) {
        throw new Error('Edits must be objects with a string "edit" field, e.g. [{"label":"MUTATION","edit":"..."}]');
      }
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
  
  // Step 2: Apply edits — VALIDATED and retried, not adopted blind. A weak or
  // overloaded service model routinely returns something other than a prompt
  // here: the edit list itself as JSON (which once became a champion prompt),
  // the instruction echoed instead of performed, the template's <<< >>>
  // scaffolding, or the parent byte-for-byte — a paid no-op the engine then
  // re-measured under a changelog claiming two applied mutations.
  const applyPromptTemplate = getApplyPromptTemplate();
  const applyPromptBase = fillTemplate(applyPromptTemplate, {
    // Sanitized: the operator prompt fences the parent in <<< >>> exactly like
    // the judge prompt does, and the parent is model-authored. Unsanitized, a
    // candidate could close the fence and instruct the model REWRITING it —
    // a self-replication channel, not merely a score bump.
    basePrompt: sanitizeForJudge(basePrompt),
    edits: JSON.stringify(edits),
  });

  // The model saw the SANITIZED parent, so a verbatim echo equals that form,
  // not necessarily the raw one — compare against both.
  const applyCheck = {
    parents: [basePrompt, sanitizeForJudge(basePrompt)],
    instructions: edits!.map(e => String((e as any).edit ?? '')),
  };

  let lastProblem: AppliedPromptProblem | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Every apply attempt is checked (not just retries): the proposal step's
    // spend precedes this loop and may already have crossed the cap.
    if (shouldAbort?.(totalUsd)) {
      console.warn('[Mutation] Budget exhausted before the apply step — carrying the parent');
      return budgetCarry('the mutation apply step');
    }
    const applyPrompt = attempt === 0
      ? applyPromptBase
      : `${applyPromptBase}\n\nIMPORTANT: Your previous reply was rejected because it ` +
        `${lastProblem?.reason ?? 'was unusable'}. Reply with the complete rewritten prompt TEXT only — ` +
        'not the edit instructions, not JSON, no <<< >>> delimiters.';

    const applyResult = await serviceAdapter.call({
      model: config.serviceModel.model,
      prompt: applyPrompt,
      temperature: 0.3,
      maxTokens,
      timeoutMs: config.callTimeoutMs,
    });

    totalPromptTokens += applyResult.promptTokens;
    totalCompletionTokens += applyResult.completionTokens;
    totalUsd += applyResult.usd;
    totalCalls++;

    const newPrompt = stripPromptDelimiters(applyResult.output ?? '');
    lastProblem = appliedPromptProblem(newPrompt, applyCheck);

    if (!lastProblem) {
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

    console.warn(
      `[Mutation] Apply attempt ${attempt + 1}/${maxRetries} rejected — the applied prompt ${lastProblem.reason}`,
    );
  }

  // Exhausted. The parent is a valid prompt — carry it under an HONEST
  // changelog instead of fabricated MUTATION lines, and instead of throwing,
  // which would destroy a generation-0 slot in the fill path.
  console.warn(
    `[Mutation] All ${maxRetries} apply attempt(s) rejected (${lastProblem!.reason}) — carrying the parent unchanged. ` +
    `Total cost: $${totalUsd.toFixed(6)}`,
  );
  return {
    prompt: basePrompt,
    changeLog: [{
      label: 'CARRY' as const,
      text: `Mutation rejected after ${maxRetries} attempt(s): the applied prompt ${lastProblem!.reason} — carried the parent unchanged`,
    }],
    cost: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    },
  };

  } catch (error) {
    // Calls already made are already billed — hand the spend to the caller
    // instead of discarding it with the exception.
    throw withPartialCost(error, {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    });
  }
}

