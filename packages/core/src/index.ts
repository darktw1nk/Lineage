/**
 * @promptengine/core — public API surface.
 *
 * The host application (Electron desktop, CLI, or an embedding program)
 * injects platform services before starting an evaluation:
 *   setStore(...)       — key/value settings + API key storage
 *   setSendUpdate(...)  — engine event sink (IPC, collector, ...)
 *   initializeDatabase(dbPath) — sql.js persistence location
 */

export type * from './types.js';
export { store, setStore } from './store.js';
export type { StoreInterface } from './store.js';
export { SqlJsWrapper, getDatabase, initializeDatabase, closeDatabase } from './database/init.js';
export {
  setSendUpdate,
  startEvaluation,
  pauseEvaluation,
  resumeEvaluation,
  stopEvaluation,
} from './engine/evaluator_v2.js';
export { initGlobalSemaphore, updateGlobalSemaphoreLimit, withGlobalSemaphore } from './engine/semaphore.js';
export { getProviderAdapter } from './providers/index.js';
export { OpenRouterAdapter } from './providers/openrouter.js';
export type { OpenRouterModel } from './providers/openrouter.js';
export { getModelCost } from './providers/costs.js';
export { withRetry, isRetryableError, RetryableError } from './providers/retry.js';
export type { RetryOptions } from './providers/retry.js';
export { levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from './utils/distance.js';
export {
  registerOperator, registerProvider, getOperator, listOperators, listProviders,
  resetRegistry, flushPendingPluginModels, BUILTIN_OPERATOR_NAMES,
} from './registry.js';
export { BaseProviderAdapter } from './providers/base.js';
export { loadPlugins } from './pluginLoader.js';
export { partitionTestSet } from './engine/holdout.js';
export { mulberry32, rngFor } from './engine/rng.js';
export { isEvaluationActive } from './engine/evaluator_v2.js';
export { scoreJsonSchema, scoreToolCall } from './engine/structured.js';
export { estimateRunCost, COST_LABELS } from './engine/estimate.js';
export type { CostEstimate } from './engine/estimate.js';
export { selectChampion } from './engine/champion.js';
export { runPairwisePlayoff } from './engine/pairwise.js';
export type { PlayoffOptions, PlayoffResult } from './engine/pairwise.js';
export type { LoadPluginsOptions } from './pluginLoader.js';
export type {
  OperatorContext, OperatorResult, OperatorPlugin, ProviderPlugin, PluginManifest,
} from './types.js';
