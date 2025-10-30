/**
 * Meta-Prompting Operations
 * 
 * Smart, failure-aware mutation that analyzes test failures
 * and suggests targeted fixes
 */

import type { CandidateNode, EvaluationConfig, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';

const DEFAULT_METAPROMPT_WITH_FAILURES = `SYSTEM: You are a prompt surgeon. Suggest surgical changes to improve the prompt based on failures.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>
Top failures: \${failureSummary}

Analyze these failures and suggest 1-3 targeted edits to address them.
Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_WITHOUT_FAILURES = `SYSTEM: You are a prompt surgeon. Suggest surgical improvements to make the prompt even better.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>
This prompt is performing well with no test failures. Suggest 1-3 refinements to further improve:
- Clarity and precision
- Edge case handling
- Output quality

Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_APPLY = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${parentPrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`;

/**
 * Load metaprompt templates from storage or use defaults
 */
function getMetapromptTemplates(): { withFailures: string; withoutFailures: string; apply: string } {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts) {
      return {
        withFailures: prompts.metapromptWithFailuresPrompt || DEFAULT_METAPROMPT_WITH_FAILURES,
        withoutFailures: prompts.metapromptWithoutFailuresPrompt || DEFAULT_METAPROMPT_WITHOUT_FAILURES,
        apply: prompts.metapromptApplyPrompt || DEFAULT_METAPROMPT_APPLY,
      };
    }
  } catch (error) {
    console.error('[Metaprompt] Failed to load custom prompts, using defaults:', error);
  }
  return {
    withFailures: DEFAULT_METAPROMPT_WITH_FAILURES,
    withoutFailures: DEFAULT_METAPROMPT_WITHOUT_FAILURES,
    apply: DEFAULT_METAPROMPT_APPLY,
  };
}

/**
 * Meta-prompt a node based on failure analysis
 * 
 * Analyzes failed tests from the current generation and suggests
 * surgical changes to address specific failure patterns.
 * 
 * Two-step process:
 * 1. Propose surgical edits based on failure summary (temp=0.8)
 * 2. Apply edits (temp=0.3)
 * 
 * @param parent - The parent node to improve
 * @param config - Evaluation configuration
 * @param generation - Current generation nodes (for failure analysis)
 * @returns New prompt, changelog, and cost tracking
 */
export async function metaPromptNode(
  parent: CandidateNode,
  config: EvaluationConfig,
  generation: CandidateNode[]
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Extract top 3 failures from generation
  const failed = generation
    .filter(n => n.tests && n.tests.some(t => !t.passed))
    .slice(0, 3)
    .map(n => {
      const failedTests = n.tests!.filter(t => !t.passed);
      return `${failedTests.length} tests failed with avg score ${(failedTests.reduce((s, t) => s + t.score, 0) / failedTests.length).toFixed(1)}`;
    });
  
  const hasFailures = failed.length > 0;
  const failureSummary = failed.join(', ');
  
  console.log(`[MetaPrompt] ${hasFailures ? `Failures found: ${failureSummary}` : 'No failures found, suggesting general improvements'}`);
  
  // Load prompt templates
  const templates = getMetapromptTemplates();
  
  // Step 1: Propose surgical edits - either based on failures or general improvements
  let metaPrompt: string;
  if (hasFailures) {
    metaPrompt = templates.withFailures
      .replace(/\$\{parentPrompt\}/g, parent.prompt)
      .replace(/\$\{failureSummary\}/g, failureSummary);
  } else {
    metaPrompt = templates.withoutFailures
      .replace(/\$\{parentPrompt\}/g, parent.prompt);
  }
  
  const proposalResult = await serviceAdapter.call({
    model: config.serviceModel.model,
    prompt: metaPrompt,
    temperature: 0.8,
    maxTokens,
  });
  
  totalPromptTokens += proposalResult.promptTokens;
  totalCompletionTokens += proposalResult.completionTokens;
  totalUsd += proposalResult.usd;
  totalCalls++;
  
  if (!proposalResult.output || proposalResult.output.trim() === '') {
    throw new Error('Empty response from meta-prompting');
  }
  
  // Parse edits
  let edits: any[];
  try {
    const cleaned = proposalResult.output.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    console.log(`[MetaPrompt] Raw output:`, proposalResult.output);
    console.log(`[MetaPrompt] Cleaned output:`, cleaned);
    edits = JSON.parse(cleaned);
    console.log(`[MetaPrompt] Parsed edits:`, edits);
  } catch (error) {
    console.error(`[MetaPrompt] Parse error:`, error);
    console.error(`[MetaPrompt] Failed to parse:`, proposalResult.output);
    throw new Error(`Failed to parse meta-prompt edits: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Step 2: Apply edits
  const applyPrompt = templates.apply
    .replace(/\$\{parentPrompt\}/g, parent.prompt)
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
    throw new Error('Empty response from meta-prompt apply');
  }
  
  return {
    prompt: applyResult.output.trim(),
    changeLog: edits.map(e => ({
      label: 'META' as const,
      text: e.edit || 'Unknown meta-edit',
    })),
    cost: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    },
  };
}

