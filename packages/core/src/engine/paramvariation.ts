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
  shouldVary: boolean,
  rng: () => number = Math.random
): ParamVariationResult {
  const result: ParamVariationResult = {
    temperature: baseTemperature,
    changeLog: [],
  };
  
  if (!shouldVary || !config.operators.paramVariation?.enabled) {
    return result;
  }
  
  // Temperature variation.
  //
  // `temperature` is documented as optional on paramVariation, and the CLI
  // replaces the whole sub-object — so enabling the operator without it
  // produced children that were EXACT clones of their parent, with an empty
  // changelog and no error. Whole generations of duplicates, no evolution, full
  // price. Vary by default instead; the operator exists to vary something.
  const tempConfig = config.operators.paramVariation.temperature;
  if (tempConfig?.enabled !== false) {
    const min = tempConfig?.min ?? 0.3;
    const max = tempConfig?.max ?? 1.5;
    result.temperature = min + rng() * (max - min);
    result.changeLog.push({
      label: 'PARAM',
      text: `Temperature varied to ${result.temperature.toFixed(2)}`,
    });
  } else {
    // Explicitly disabled: say so, like the model operator does, rather than
    // emitting a silent clone.
    result.changeLog.push({
      label: 'CARRY',
      text: 'Parameter variation has nothing enabled to vary — carrying parent parameters',
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

