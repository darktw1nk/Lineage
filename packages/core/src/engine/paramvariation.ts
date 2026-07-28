/**
 * Parameter Variation Operator
 * 
 * Varies execution parameters (temperature, seed, etc.) to explore
 * the parameter space alongside prompt evolution
 * 
 * Currently supports:
 * - Temperature variation: random sampling within configured range
 * 
 * Future extensions:
 * - Seed variation: random seed assignment
 * - max_tokens, top_p, top_k variation
 */

import type { EvaluationConfig, ChangeLogLine } from '../types.js';

export interface ParamVariationResult {
  temperature: number;
  changeLog: ChangeLogLine[];
}

/**
 * Apply parameter variation based on configuration
 * Returns modified parameters and changelog entries
 */
export function varyParameters(
  baseTemperature: number,
  config: EvaluationConfig,
  shouldVary: boolean
): ParamVariationResult {
  const result: ParamVariationResult = {
    temperature: baseTemperature,
    changeLog: [],
  };
  
  if (!shouldVary || !config.operators.paramVariation?.enabled) {
    return result;
  }
  
  // Temperature variation
  if (config.operators.paramVariation.temperature?.enabled) {
    const tempConfig = config.operators.paramVariation.temperature;
    const min = tempConfig?.min ?? 0.3;
    const max = tempConfig?.max ?? 1.5;
    result.temperature = min + Math.random() * (max - min);
    result.changeLog.push({
      label: 'PARAM',
      text: `Temperature varied to ${result.temperature.toFixed(2)}`,
    });
  }
  
  return result;
}


/**
 * Get temperature within configured range (for fallback/default)
 */
export function getDefaultTemperature(config: EvaluationConfig): number {
  if (config.operators.paramVariation?.enabled) {
    const tempConfig = config.operators.paramVariation.temperature;
    const min = tempConfig?.min ?? 0.3;
    const max = tempConfig?.max ?? 1.5;
    // Return middle of range as default
    return (min + max) / 2;
  }
  return 0.7; // System default
}

