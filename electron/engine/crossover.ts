/**
 * Crossover Operator
 * 
 * Combines two parent prompts by merging their best characteristics
 * Uses service LLM to intelligently merge without redundancy
 */

import type { CandidateNode, EvaluationConfig, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';

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
  
  const crossoverPromptTemplate = getCrossoverPromptTemplate();
  const crossoverPrompt = crossoverPromptTemplate
    .replace(/\$\{parentA\}/g, parentA.prompt)
    .replace(/\$\{parentB\}/g, parentB.prompt);
  
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

