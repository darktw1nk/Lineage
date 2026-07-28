/**
 * CLI Config Loader
 *
 * Loads a simplified JSON config and maps it to a full EvaluationConfig.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationConfig, ModelRef, TestCase, Provider } from '@promptengine/core';

export interface CliConfig {
  name?: string;
  seedPrompt?: string;
  initialPrompts?: string[];
  testSet: Array<{
    id?: string;
    name?: string;
    mode?: 'llm_grade' | 'exact_match';
    prompt: string;
    expected?: string;
    image?: string; // path to image file (relative to config or absolute)
    grading?: {
      strictZeroOnDeviation?: boolean;
      distanceMetric?: 'levenshtein' | 'json_diff' | 'numeric_abs';
    };
  }>;
  models?: string[];          // e.g. ["openai/gpt-4o", "anthropic/claude-sonnet-4.5"]
  serviceModel?: string;      // e.g. "openai/gpt-4o-mini"
  plugins?: string[];         // plugin file/dir paths, resolved relative to the config file
  populationSize?: number;
  generationSize?: number;
  maxGenerations?: number;
  budget?: number;
  targetFitness?: number;
  timeLimitMs?: number;
  parallelLimit?: number;
  serviceModelMaxTokens?: number;
  retries?: number;
  fitnessWeights?: {
    quality?: number;
    safety?: number;
    cost?: number;
    latency?: number;
    stability?: number;
  };
  guardrails?: string[];
  costNorm?: { mode: 'absolute' | 'relative'; maxUSDPerCall: number };
  latencyNorm?: { mode: 'absolute' | 'relative'; maxMs: number };
  selection?: {
    policy?: 'topk' | 'topp';
    topK?: number;
    topP?: number;
    eliteShare?: number;
  };
  operators?: {
    mutationShare?: number;
    crossoverShare?: number;
    metaPrompting?: { enabled: boolean; share: number };
    modelVariation?: { enabled: boolean; share: number };
    paramVariation?: {
      enabled: boolean;
      share: number;
      temperature?: { enabled: boolean; min: number; max: number };
    };
    custom?: Record<string, { enabled?: boolean; share: number }>; // plugin operator shares
  };
  // Inline API keys (lower priority than env vars)
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  openrouterKey?: string;
  groqKey?: string;
  // Extra options passed to candidate model calls (e.g. reasoning_effort)
  providerOptions?: Record<string, any>;
  // Custom system prompts (override LLM judge, mutation, crossover, meta-prompting prompts)
  systemPrompts?: {
    llmGradingPrompt?: string;
    safetyGuardrailPrompt?: string;
    mutationStrategies?: string;
    mutationProposalPrompt?: string;
    mutationApplyPrompt?: string;
    crossoverPrompt?: string;
    metapromptWithFailuresPrompt?: string;
    metapromptWithoutFailuresPrompt?: string;
    metapromptApplyPrompt?: string;
  };
}

function parseModelRef(modelStr: string): ModelRef {
  const slashIdx = modelStr.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid model format "${modelStr}". Expected "provider/model" (e.g., "openai/gpt-4o")`);
  }
  const provider = modelStr.slice(0, slashIdx) as Provider;
  const model = modelStr.slice(slashIdx + 1);

  const validProviders: Provider[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq'];
  if (!validProviders.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Valid providers: ${validProviders.join(', ')}`);
  }

  return { provider, model };
}

export function loadCliConfig(configPath: string): CliConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  let config: CliConfig;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }
  validateCliConfig(config);
  return config;
}

export function validateCliConfig(config: CliConfig): void {
  const hasInitialPrompts = Array.isArray(config.initialPrompts);

  if (hasInitialPrompts) {
    if (config.initialPrompts!.length === 0) {
      throw new Error('"initialPrompts" must be a non-empty array');
    }
    for (const [i, p] of config.initialPrompts!.entries()) {
      if (!p || typeof p !== 'string') {
        throw new Error(`initialPrompts[${i}] must be a non-empty string`);
      }
    }
  } else {
    if (!config.seedPrompt || typeof config.seedPrompt !== 'string') {
      throw new Error('Config must have a "seedPrompt" string (or provide "initialPrompts")');
    }
  }

  if (!Array.isArray(config.testSet) || config.testSet.length === 0) {
    throw new Error('Config must have a non-empty "testSet" array');
  }
  for (const [i, test] of config.testSet.entries()) {
    if (!test.prompt || typeof test.prompt !== 'string') {
      throw new Error(`testSet[${i}] must have a "prompt" string`);
    }
  }
  if (config.models) {
    for (const m of config.models) {
      parseModelRef(m); // validates format
    }
  }
  if (config.serviceModel) {
    parseModelRef(config.serviceModel);
  }
}

export function toEvaluationConfig(config: CliConfig, configDir?: string): EvaluationConfig {
  const enabledModels: ModelRef[] = (config.models || ['openai/gpt-4o-mini']).map(parseModelRef);
  const serviceModel: ModelRef = config.serviceModel
    ? parseModelRef(config.serviceModel)
    : enabledModels[0];

  const testSet: TestCase[] = config.testSet.map((t, i) => {
    let imagePath = t.image;
    if (imagePath && configDir && !path.isAbsolute(imagePath)) {
      imagePath = path.resolve(configDir, imagePath);
    }
    return {
      id: t.id || uuidv4(),
      name: t.name || `Test ${i + 1}`,
      mode: t.mode || 'llm_grade',
      prompt: t.prompt,
      expected: t.expected,
      image: imagePath,
      grading: t.grading,
    };
  });

  const defaultWeights = { quality: 1.0 };
  const weights = config.fitnessWeights
    ? { quality: config.fitnessWeights.quality ?? 1.0, ...config.fitnessWeights }
    : defaultWeights;

  const useManualFill = Array.isArray(config.initialPrompts) && config.initialPrompts.length > 0;
  const populationSize = useManualFill
    ? config.initialPrompts!.length
    : (config.populationSize ?? 6);
  const generationSize = config.generationSize ?? populationSize;

  const population: any = useManualFill
    ? {
        initialSize: populationSize,
        generationSize,
        seedPrompt: config.seedPrompt || config.initialPrompts![0],
        fill: 'manual' as const,
        manualPrompts: config.initialPrompts!.map((prompt, i) => ({
          prompt,
          model: enabledModels[i % enabledModels.length],
        })),
      }
    : {
        initialSize: populationSize,
        generationSize,
        seedPrompt: config.seedPrompt,
        fill: 'auto' as const,
      };

  return {
    id: uuidv4(),
    name: config.name || 'CLI Evolution',
    selection: {
      policy: config.selection?.policy || 'topk',
      topK: config.selection?.topK ?? 3,
      topP: config.selection?.topP,
      eliteShare: config.selection?.eliteShare ?? 0.05,
    },
    operators: {
      mutationShare: config.operators?.mutationShare ?? 0.5,
      crossoverShare: config.operators?.crossoverShare ?? 0.2,
      metaPrompting: config.operators?.metaPrompting ?? { enabled: true, share: 0.2 },
      modelVariation: config.operators?.modelVariation ?? { enabled: enabledModels.length > 1, share: 0.1 },
      paramVariation: config.operators?.paramVariation ?? { enabled: true, share: 0.1, temperature: { enabled: true, min: 0.3, max: 1.5 } },
      ...(config.operators?.custom ? { custom: config.operators.custom } : {}),
    },
    population,
    enabledModels,
    testSet,
    fitness: {
      weights,
      guardrails: config.guardrails,
      costNorm: config.costNorm,
      latencyNorm: config.latencyNorm,
    },
    targets: {
      maxGenerations: config.maxGenerations ?? 3,
      budgetUSD: config.budget,
      targetFitness: config.targetFitness,
      timeLimitMs: config.timeLimitMs,
    },
    serviceModel,
    parallelLimit: config.parallelLimit ?? 5,
    serviceModelMaxTokens: config.serviceModelMaxTokens ?? 20000,
    retries: config.retries ?? 3,
    providerOptions: config.providerOptions,
  };
}

/**
 * Extract inline API keys from CLI config (used for key resolution).
 */
export function extractConfigKeys(config: CliConfig): Record<string, string> {
  const keys: Record<string, string> = {};
  if (config.openaiKey) keys.openaiKey = config.openaiKey;
  if (config.anthropicKey) keys.anthropicKey = config.anthropicKey;
  if (config.geminiKey) keys.geminiKey = config.geminiKey;
  if (config.openrouterKey) keys.openrouterKey = config.openrouterKey;
  if (config.groqKey) keys.groqKey = config.groqKey;
  return keys;
}
