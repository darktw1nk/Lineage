/**
 * Mutation Operations
 * 
 * Handles prompt mutation using LLM-based edit proposals and application
 */

import type { EvaluationConfig, ChangeLogLine } from '../../src/types/index.js';
import { getProviderAdapter } from '../providers/index.js';

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

