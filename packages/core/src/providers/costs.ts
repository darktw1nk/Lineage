import { getDatabase } from '../database/init.js';
import type { ModelRef, ModelCostEntry } from '../types.js';

export async function getModelCost(modelRef: ModelRef): Promise<ModelCostEntry | null> {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT provider, model, prompt_usd_per_1k, completion_usd_per_1k
    FROM model_costs
    WHERE provider = ? AND model = ?
  `).get(modelRef.provider, modelRef.model) as any;
  
  if (!row) return null;
  
  return {
    provider: row.provider,
    model: row.model,
    promptUSDper1k: row.prompt_usd_per_1k,
    completionUSDper1k: row.completion_usd_per_1k,
  };
}

