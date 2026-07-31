/**
 * Crossover Operator
 * 
 * Combines two parent prompts by merging their best characteristics
 * Uses service LLM to intelligently merge without redundancy
 */

import type { CandidateNode, EvaluationConfig, ChangeLogLine } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';
import { withPartialCost } from './operator-cost.js';
import { stripPromptDelimiters, fillTemplate, sanitizeForJudge, appliedPromptProblem } from '../utils/text.js';
import type { AppliedPromptProblem } from '../utils/text.js';

const DEFAULT_CROSSOVER_PROMPT = `SYSTEM: Merge best parts of A and B into a coherent prompt without redundancy.
USER: A: <<<
\${parentA}
>>>
B: <<<
\${parentB}
>>>
Return the merged prompt ONLY.`;

/**
 * Load crossover prompt template from storage or use default
 */
function getCrossoverPromptTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts && prompts.crossoverPrompt) {
      return prompts.crossoverPrompt;
    }
  } catch (error) {
    console.error('[Crossover] Failed to load custom prompt, using default:', error);
  }
  return DEFAULT_CROSSOVER_PROMPT;
}

/**
 * Crossover between two parents
 * Merges the best parts of both prompts into a coherent offspring
 */
export async function crossoverNodes(
  parentA: CandidateNode,
  parentB: CandidateNode,
  config: EvaluationConfig
): Promise<{ 
  prompt: string; 
  changeLog: ChangeLogLine[]; 
  cost: { promptTokens: number; completionTokens: number; usd: number; calls: number } 
}> {
  const serviceAdapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = (config as any).serviceModelMaxTokens || 20000;
  const maxRetries = Math.max(1, config.retries ?? 3);

  const crossoverPromptTemplate = getCrossoverPromptTemplate();
  const crossoverPromptBase = fillTemplate(crossoverPromptTemplate, {
    // Sanitized: the operator prompt fences the parent in <<< >>> exactly like
    // the judge prompt does, and the parent is model-authored. Unsanitized, a
    // candidate could close the fence and instruct the model REWRITING it —
    // a self-replication channel, not merely a score bump.
    parentA: sanitizeForJudge(parentA.prompt),
    parentB: sanitizeForJudge(parentB.prompt),
  });

  // The merge is VALIDATED before adoption (open-bugs 2026-07-31 #1/#2): a
  // reply equal to either parent is a paid no-op, and JSON / template
  // scaffolding is the model talking about the task, not doing it. The model
  // saw the SANITIZED parents, so echoes are compared against both forms.
  const check = {
    parents: [
      parentA.prompt, parentB.prompt,
      sanitizeForJudge(parentA.prompt), sanitizeForJudge(parentB.prompt),
    ],
  };

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsd = 0;
  let totalCalls = 0;
  let lastProblem: AppliedPromptProblem | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const crossoverPrompt = attempt === 0
      ? crossoverPromptBase
      : `${crossoverPromptBase}\n\nIMPORTANT: Your previous reply was rejected because it ` +
        `${lastProblem?.reason ?? 'was unusable'}. Reply with the merged prompt TEXT only — ` +
        'not JSON, no <<< >>> delimiters.';

    const result = await serviceAdapter.call({
      model: config.serviceModel.model,
      prompt: crossoverPrompt,
      temperature: 0.7,
      maxTokens,
      timeoutMs: config.callTimeoutMs,
    });

    totalPromptTokens += result.promptTokens;
    totalCompletionTokens += result.completionTokens;
    totalUsd += result.usd;
    totalCalls++;

    const merged = stripPromptDelimiters(result.output ?? '');
    lastProblem = appliedPromptProblem(merged, check);

    if (!lastProblem) {
      return {
        prompt: merged,
        changeLog: [{
          label: 'CROSSOVER' as const,
          text: `Merged ${parentA.id.slice(0, 8)} + ${parentB.id.slice(0, 8)}`,
        }],
        cost: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          usd: totalUsd,
          calls: totalCalls,
        },
      };
    }

    console.warn(
      `[Crossover] Attempt ${attempt + 1}/${maxRetries} rejected — the merged prompt ${lastProblem.reason}`,
    );
  }

  // A merge that equals a parent is not an error — the parent is a valid
  // prompt. Carry it under an honest CARRY line instead of a CROSSOVER line
  // claiming a merge that never happened.
  if (lastProblem!.code === 'noop') {
    console.warn(`[Crossover] All ${maxRetries} attempt(s) returned a parent unchanged — carrying parent A`);
    return {
      prompt: parentA.prompt,
      changeLog: [{
        label: 'CARRY' as const,
        text: `Crossover rejected after ${maxRetries} attempt(s): the merged prompt ${lastProblem!.reason} — carried ${parentA.id.slice(0, 8)} unchanged`,
      }],
      cost: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        usd: totalUsd,
        calls: totalCalls,
      },
    };
  }

  // The calls were made and billed even though their output is unusable — hand
  // the spend to the caller instead of discarding it with the exception.
  throw withPartialCost(
    new Error(`Crossover output rejected after ${maxRetries} attempt(s): it ${lastProblem!.reason}`),
    {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      usd: totalUsd,
      calls: totalCalls,
    },
  );
}

