/**
 * Meta-Prompting Operations
 * 
 * Smart, failure-aware mutation that analyzes test failures
 * and suggests targeted fixes
 */

import type { CandidateNode, EvaluationConfig, ChangeLogLine } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';
import { stripPromptDelimiters, extractJsonArray } from '../utils/text.js';

const DEFAULT_METAPROMPT_WITH_FAILURES = `SYSTEM: You are a prompt surgeon. You analyze concrete test failures to suggest targeted fixes. You can ADD, REMOVE, or REWRITE any part of the prompt — including removing instructions that conflict with what the tests require.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>

FAILED/LOW-SCORING TESTS (worst first):
\${failureSummary}

Analyze the specific failure reasons above. Identify which parts of the prompt cause these failures — sometimes the prompt actively instructs something the tests penalize.
Suggest 1-3 targeted edits. Be bold: if a line in the prompt conflicts with what grading rewards, REMOVE or REPLACE it.
Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_WITHOUT_FAILURES = `SYSTEM: You are a prompt surgeon. Even when all tests pass, you find the weakest areas and improve them. You can ADD, REMOVE, or REWRITE any part of the prompt.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>

LOWEST-SCORING TESTS (room for improvement):
\${failureSummary}

These tests pass but score below perfect. Analyze the grading feedback and suggest 1-3 targeted edits to push scores higher.
Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_APPLY = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${parentPrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`;

/**
 * Build a rich failure summary from the parent's own test results.
 * Sorts tests by score ascending, takes the worst N, and includes
 * test name, score, input (truncated), output (truncated), and grading justification.
 */
function buildFailureSummary(parent: CandidateNode, config: EvaluationConfig, maxTests: number = 5): string {
  if (!parent.tests || parent.tests.length === 0) {
    return '(No test results available)';
  }

  // Build a testId → TestCase lookup from config
  const testLookup = new Map<string, { name: string; prompt: string; expected?: string }>();
  if (config.testSet) {
    for (const tc of config.testSet) {
      testLookup.set(tc.id, { name: tc.name, prompt: tc.prompt, expected: tc.expected });
    }
  }

  // Sort by score ascending (worst first), take bottom N
  const sorted = [...parent.tests].sort((a, b) => a.score - b.score).slice(0, maxTests);

  const lines: string[] = [];
  for (const test of sorted) {
    const tc = testLookup.get(test.testId);
    const name = tc?.name || 'Unknown test';
    const input = truncate(tc?.prompt || '', 200);
    const output = truncate(test.outputText || '', 300);
    const expected = tc?.expected ? truncate(tc.expected, 200) : null;
    const justification = extractJustification(test.llmGradeReasoning || '');

    lines.push(`--- Test: "${name}" — Score: ${test.score}/10 ${test.passed ? '(PASS)' : '(FAIL)'}`);
    lines.push(`Input: ${input}`);
    if (expected) {
      lines.push(`Expected: ${expected}`);
    }
    lines.push(`Actual output: ${output}`);
    if (justification) {
      lines.push(`Grading feedback: ${justification}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + '...';
}

function extractJustification(reasoning: string): string {
  if (!reasoning) return '';
  try {
    // Strip markdown code blocks if present
    let jsonText = reasoning.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(jsonText);
    return parsed.justification || '';
  } catch {
    // If not JSON, return as-is (truncated)
    return truncate(reasoning, 200);
  }
}

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
  _generation: CandidateNode[]
): Promise<{ prompt: string; changeLog: ChangeLogLine[]; cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } }> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  
  // Build rich failure details from the PARENT's own test results
  const failureDetails = buildFailureSummary(parent, config);
  const hasFailures = parent.tests ? parent.tests.some(t => !t.passed) : false;

  console.log(`[MetaPrompt] ${hasFailures ? 'Parent has failing tests' : 'All tests passing, showing lowest scores'}`);
  console.log(`[MetaPrompt] Failure summary length: ${failureDetails.length} chars`);
  
  // Load prompt templates
  const templates = getMetapromptTemplates();
  
  // Step 1: Propose surgical edits - either based on failures or general improvements
  let metaPrompt: string;
  if (hasFailures) {
    metaPrompt = templates.withFailures
      .replace(/\$\{parentPrompt\}/g, parent.prompt)
      .replace(/\$\{failureSummary\}/g, failureDetails);
  } else {
    metaPrompt = templates.withoutFailures
      .replace(/\$\{parentPrompt\}/g, parent.prompt)
      .replace(/\$\{failureSummary\}/g, failureDetails);
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
    console.log(`[MetaPrompt] Raw output:`, proposalResult.output);
    edits = extractJsonArray(proposalResult.output);
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
    prompt: stripPromptDelimiters(applyResult.output),
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

