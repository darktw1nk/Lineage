/**
 * Parameter Variation Operator
 * 
 * Varies execution parameters (temperature, model, seed, etc.) to explore
 * the parameter space alongside prompt evolution
 * 
 * Currently supports:
 * - Temperature variation: random sampling within configured range
 * 
 * Future extensions:
 * - Model variation: random model selection from enabled models
 * - Seed variation: random seed assignment
 * - max_tokens, top_p, top_k variation
 */

import type { EvaluationConfig, ModelRef, ChangeLogLine } from '../../src/types/index.js';

export interface ParamVariationResult {
  temperature: number;
  model?: ModelRef;
  changeLog: ChangeLogLine[];
}

/**
 * Apply parameter variation based on configuration
 * Returns modified parameters and changelog entries
 */
export function varyParameters(
  baseTemperature: number,
  baseModel: ModelRef,
  config: EvaluationConfig,
  shouldVary: boolean
): ParamVariationResult {
  const result: ParamVariationResult = {
    temperature: baseTemperature,
    model: baseModel,
    changeLog: [],
  };
  
  if (!shouldVary || !config.operators.paramVariation?.enabled) {
    return result;
  }
  
  // Temperature variation
  if (config.operators.paramVariation.temperature) {
    const tempConfig = config.operators.paramVariation.temperature;
    const min = tempConfig.min || 0.3;
    const max = tempConfig.max || 1.5;
    result.temperature = min + Math.random() * (max - min);
    result.changeLog.push({
      label: 'PARAM',
      text: `Temperature varied to ${result.temperature.toFixed(2)}`,
    });
  }
  
  // Future: Model variation
  // if (config.operators.paramVariation.model?.enabled) {
  //   result.model = selectRandomModel(config.enabledModels);
  //   result.changeLog.push({
  //     label: 'PARAM',
  //     text: `Model varied to ${result.model.model}`,
  //   });
  // }
  
  return result;
}

/**
 * Determine if parameter variation should be applied for this child
 * Based on configured share probability
 */
export function shouldApplyParamVariation(config: EvaluationConfig): boolean {
  if (!config.operators.paramVariation?.enabled) {
    return false;
  }
  
  const share = config.operators.paramVariation.share || 0.2;
  return Math.random() < share;
}

/**
 * Get temperature within configured range (for fallback/default)
 */
export function getDefaultTemperature(config: EvaluationConfig): number {
  if (config.operators.paramVariation?.enabled) {
    const tempConfig = config.operators.paramVariation.temperature;
    const min = tempConfig.min || 0.3;
    const max = tempConfig.max || 1.5;
    // Return middle of range as default
    return (min + max) / 2;
  }
  return 0.7; // System default
}

