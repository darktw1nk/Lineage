/**
 * Model Variation Operator
 * 
 * Randomly selects models from the enabled model pool to explore
 * different model capabilities alongside prompt evolution.
 * 
 * Unlike round-robin model assignment, this allows the genetic algorithm
 * to discover which models work best for which prompts.
 */

import type { EvaluationConfig, ModelRef, ChangeLogLine } from '../types.js';

export interface ModelVariationResult {
  model: ModelRef;
  changeLog: ChangeLogLine[];
}

/**
 * Apply model variation based on configuration
 * Returns modified model and changelog entry
 */
export function varyModel(
  baseModel: ModelRef,
  config: EvaluationConfig,
  shouldVary: boolean,
  enabledModels: ModelRef[]
): ModelVariationResult {
  const result: ModelVariationResult = {
    model: baseModel,
    changeLog: [],
  };
  
  if (!shouldVary || !config.operators.modelVariation?.enabled || enabledModels.length <= 1) {
    return result;
  }
  
  // Filter out the current model to ensure we select a different one
  const otherModels = enabledModels.filter(
    m => m.provider !== baseModel.provider || m.model !== baseModel.model
  );
  
  // If all models are the same (shouldn't happen, but safety check)
  if (otherModels.length === 0) {
    return result;
  }
  
  // Select random model from OTHER models (guaranteed to be different)
  const randomModel = otherModels[Math.floor(Math.random() * otherModels.length)];
  
  result.model = randomModel;
  result.changeLog.push({
    label: 'MODEL',
    text: `Model varied to ${randomModel.provider}/${randomModel.model}`,
  });
  
  return result;
}