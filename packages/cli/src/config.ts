/**
 * CLI Config Loader
 *
 * Loads a simplified JSON config and maps it to a full EvaluationConfig.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationConfig, ModelRef, TestCase, Provider } from '@lineage/core';
import { listProviders } from '@lineage/core';

export interface CliConfig {
  name?: string;
  seedPrompt?: string;
  initialPrompts?: string[];
  testSet: Array<{
    id?: string;
    name?: string;
    mode?: 'llm_grade' | 'exact_match' | 'json_schema' | 'tool_call';
    prompt: string;
    expected?: string;
    image?: string; // path to image file (relative to config or absolute)
    holdout?: boolean; // excluded from evolution; used for the generalization report
    grading?: {
      strictZeroOnDeviation?: boolean;
      distanceMetric?: 'levenshtein' | 'json_diff' | 'numeric_abs';
    };
    schema?: object; // json_schema mode
    tools?: Array<{ name: string; description?: string; parameters?: object }>; // tool_call mode
    expectedTool?: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' }; // tool_call mode
  }>;
  models?: string[];          // e.g. ["openai/gpt-4o", "anthropic/claude-sonnet-4.5"]
  serviceModel?: string;      // e.g. "openai/gpt-4o-mini"
  plugins?: string[];         // plugin file/dir paths, resolved relative to the config file
  promptMode?: 'system' | 'inline'; // default 'system': candidate prompt as system message
  samplesPerTest?: number;    // default 1: samples averaged per test
  holdoutShare?: number;      // default 0: seeded share of non-flagged tests held out
  holdoutSeed?: number;       // default 42: PRNG seed for the share split
  pairwise?: { enabled: boolean; contenders?: number }; // opt-in playoff among top contenders
  seed?: number;              // run-level reproducibility seed
  callTimeoutMs?: number;     // per-attempt LLM call timeout in ms (default 120000)
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
    diversity?: number;
    restartAfter?: number;
    novelty?: number;
  };
  operators?: {
    mutationShare?: number;
    crossoverShare?: number;
    adaptivity?: number;
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

/**
 * @param checkProvider validate the provider name against the registry. Config
 * validation runs BEFORE plugins load, so it must check format only — plugin
 * providers (docs/plugins.md documents "ollama/llama3.2") aren't registered yet.
 * toEvaluationConfig runs after plugin load and does the full check.
 */
function parseModelRef(modelStr: string, checkProvider = true): ModelRef {
  const slashIdx = modelStr.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid model format "${modelStr}". Expected "provider/model" (e.g., "openai/gpt-4o")`);
  }
  const provider = modelStr.slice(0, slashIdx) as Provider;
  const model = modelStr.slice(slashIdx + 1);

  if (checkProvider) {
    // Consult the registry, not a hardcoded list: plugin providers register
    // themselves and are perfectly valid here.
    const validProviders = listProviders();
    if (!validProviders.includes(provider)) {
      throw new Error(`Unknown provider "${provider}". Valid providers: ${validProviders.join(', ')}`);
    }
  }

  return { provider, model };
}

export function loadCliConfig(configPath: string): CliConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  // A directory produced a raw "EISDIR: illegal operation on a directory".
  if (fs.statSync(configPath).isDirectory()) {
    throw new Error(`Config path is a directory, not a file: ${configPath}`);
  }
  let raw = fs.readFileSync(configPath, 'utf-8');
  // Strip a UTF-8 BOM. Windows Notepad and PowerShell's default Out-File both
  // write one, and JSON.parse rejects it — so a perfectly valid config was
  // unloadable with only "Invalid JSON" to go on.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let config: CliConfig;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${error instanceof Error ? error.message : error}`);
  }
  validateCliConfig(config);
  return config;
}

export function validateCliConfig(config: CliConfig): void {
  // `null` parses fine as JSON and then crashed on the first property read
  // ("Cannot read properties of null (reading 'initialPrompts')").
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Config must be a JSON object (got ${config === null ? 'null' : Array.isArray(config) ? 'an array' : typeof config})`);
  }

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
  const VALID_MODES = ['llm_grade', 'exact_match', 'json_schema', 'tool_call'];
  const seenTestIds = new Set<string>();
  for (const [i, test] of config.testSet.entries()) {
    if (!test.prompt || typeof test.prompt !== 'string') {
      throw new Error(`testSet[${i}] must have a "prompt" string`);
    }
    // Duplicate ids silently corrupt everything keyed by test id: the holdout
    // split reserves the wrong number of tests, and the report resolves both
    // rows to the first match and invents an improvement that never happened.
    if (test.id !== undefined) {
      if (typeof test.id !== 'string' || test.id === '') {
        throw new Error(`testSet[${i}].id must be a non-empty string`);
      }
      if (seenTestIds.has(test.id)) {
        throw new Error(`testSet[${i}] reuses id "${test.id}" — test ids must be unique`);
      }
      seenTestIds.add(test.id);
    }
    // exact_match against nothing scores 0 for every candidate in every
    // generation: the run pays in full and produces no gradient at all.
    if (test.mode === 'exact_match' && (test.expected === undefined || test.expected === null)) {
      throw new Error(`testSet[${i}] uses mode "exact_match" but has no "expected" value to compare against`);
    }
    if (test.mode !== undefined && !VALID_MODES.includes(test.mode)) {
      throw new Error(`testSet[${i}] has unknown mode "${test.mode}" (valid: ${VALID_MODES.join(', ')})`);
    }
    if (test.mode === 'json_schema' && !test.schema) {
      throw new Error(`testSet[${i}] uses mode "json_schema" but has no "schema"`);
    }
    if (test.mode === 'tool_call') {
      if (!Array.isArray(test.tools) || test.tools.length === 0) {
        throw new Error(`testSet[${i}] uses mode "tool_call" but has no "tools" array`);
      }
      if (!test.expectedTool?.name) {
        throw new Error(`testSet[${i}] uses mode "tool_call" but "expectedTool.name" is missing`);
      }
    }
  }
  // `models: []` is truthy, so the documented default never applied and
  // serviceModel became enabledModels[0] === undefined — surfacing as
  // "Cannot read properties of undefined (reading 'provider')".
  if (config.models !== undefined) {
    if (!Array.isArray(config.models)) {
      throw new Error('"models" must be an array of "provider/model" strings');
    }
    if (config.models.length === 0) {
      throw new Error('"models" is empty — remove it to use the defaults, or list at least one "provider/model"');
    }
  }
  // Format only — plugins haven't loaded yet, so provider names are checked
  // later in toEvaluationConfig (see parseModelRef's checkProvider param).
  if (config.models) {
    for (const m of config.models) {
      parseModelRef(m, false);
    }
  }

  // Numeric sanity. None of these were checked, and the engine treats a
  // falsy/NaN target as "no limit": `maxGenerations: 0` and `maxGenerations:
  // "two"` both ran unbounded while the startup banner quoted a finite cost.
  const positiveInt = (value: unknown, field: string, min = 1) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      throw new Error(`"${field}" must be an integer >= ${min} (got ${JSON.stringify(value)})`);
    }
  };
  const nonNegativeNumber = (value: unknown, field: string) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`"${field}" must be a number >= 0 (got ${JSON.stringify(value)})`);
    }
  };
  positiveInt(config.populationSize, 'populationSize');
  positiveInt(config.generationSize, 'generationSize');
  positiveInt(config.maxGenerations, 'maxGenerations');
  positiveInt(config.parallelLimit, 'parallelLimit');
  positiveInt(config.serviceModelMaxTokens, 'serviceModelMaxTokens');
  positiveInt(config.samplesPerTest, 'samplesPerTest');
  positiveInt(config.callTimeoutMs, 'callTimeoutMs');
  positiveInt(config.timeLimitMs, 'timeLimitMs');

  // Numeric fields that reach the ENGINE unchecked. These were accepted and
  // then silently changed the run: `mutationShare: "half"` rewrote the operator
  // plan (22 calls -> 14), `eliteShare: 1.5` carried nearly a whole generation
  // forward as elites, and `fitnessWeights.cost: -2` inverts the dimension it
  // weights. All exited 0 with no warning.
  // Operator shares are RATIOS, not fractions: generation.ts divides each by
  // their total, so {2, 1} is a valid 2:1 split behaving exactly like
  // {0.667, 0.333}. Requiring 0..1 rejected working configs. What actually
  // breaks the engine is a negative or non-numeric share — totalShare then
  // goes <= 0 or NaN, EVERY operator quota becomes 0, and every child is a
  // byte-identical carry-forward of its parent while the run exits 0
  // reporting success.
  const shareValue = (value: unknown, field: string) => nonNegativeNumber(value, field);
  for (const [name, value] of Object.entries(config.operators ?? {})) {
    if (name.endsWith('Share')) { shareValue(value, `operators.${name}`); continue; }
    if (!value || typeof value !== 'object') continue;
    // Nested operator objects (metaPrompting, paramVariation, ...) carry their own share.
    if ('share' in (value as any)) { shareValue((value as any).share, `operators.${name}.share`); continue; }
    // `operators.custom` is a MAP of plugin operators, each with its own share —
    // it neither ends in `Share` nor has a `share` of its own, so it was skipped
    // entirely. That is the one share surface a user hand-writes for a plugin.
    if (name === 'custom') {
      for (const [opName, entry] of Object.entries(value as Record<string, any>)) {
        if (entry && typeof entry === 'object') {
          shareValue(entry.share, `operators.custom.${opName}.share`);
        }
      }
    }
  }
  const fraction = (value: unknown, field: string) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`"${field}" must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
    }
  };
  fraction(config.selection?.eliteShare, 'selection.eliteShare');
  fraction(config.selection?.topP, 'selection.topP');
  fraction(config.selection?.diversity, 'selection.diversity');
  positiveInt(config.selection?.restartAfter, 'selection.restartAfter');
  fraction(config.selection?.novelty, 'selection.novelty');
  fraction(config.operators?.adaptivity, 'operators.adaptivity');
  positiveInt(config.selection?.topK, 'selection.topK');
  for (const [dim, w] of Object.entries(config.fitnessWeights ?? {})) {
    nonNegativeNumber(w, `fitnessWeights.${dim}`);
  }
  nonNegativeNumber(config.costNorm?.maxUSDPerCall, 'costNorm.maxUSDPerCall');
  nonNegativeNumber(config.latencyNorm?.maxMs, 'latencyNorm.maxMs');

  // `guardrails` is the one array field a user naturally writes as prose, and
  // a bare string is iterable: fitness.ts does `for (const g of guardrails)`,
  // so a 32-character rule became 32 safety judge calls, each grading a single
  // CHARACTER as if it were a rule. Measured 34 total calls against 3 for the
  // same config with brackets — and scaled to 8 candidates x 5 generations,
  // ~1,600 meaningless paid calls. The estimator reports the inflated number
  // faithfully, so nothing looks wrong.
  if (config.guardrails !== undefined) {
    if (!Array.isArray(config.guardrails)) {
      throw new Error(
        `"guardrails" must be an ARRAY of rules, not a ${typeof config.guardrails}. ` +
        `Write ["${String(config.guardrails).slice(0, 40)}"] — a bare string is iterated character by character, ` +
        'and each character costs a safety judge call.',
      );
    }
    config.guardrails.forEach((g, i) => {
      if (typeof g !== 'string' || g.trim() === '') {
        throw new Error(`"guardrails[${i}]" must be a non-empty string (got ${JSON.stringify(g)}).`);
      }
    });
  }
  nonNegativeNumber(config.budget, 'budget');
  // targetFitness 0 is met by literally every candidate, so the run stops after
  // one generation — never what anyone means. budget 0 IS meaningful ("spend
  // nothing"), which is why only this one is rejected.
  if (config.targetFitness !== undefined) {
    nonNegativeNumber(config.targetFitness, 'targetFitness');
    if (config.targetFitness <= 0) {
      throw new Error('"targetFitness" must be greater than 0 — every candidate already meets 0, so the run would stop after one generation');
    }
    if (config.targetFitness > 10) {
      throw new Error(`"targetFitness" must be <= 10 (fitness is scored 0-10); got ${config.targetFitness}`);
    }
  }
  positiveInt(config.retries, 'retries', 0);
  if (config.seed !== undefined && (typeof config.seed !== 'number' || !Number.isFinite(config.seed))) {
    throw new Error(`"seed" must be a number (got ${JSON.stringify(config.seed)})`);
  }
  if (config.holdoutShare !== undefined) {
    if (typeof config.holdoutShare !== 'number' || !(config.holdoutShare >= 0 && config.holdoutShare < 1)) {
      throw new Error(`"holdoutShare" must be a number in [0, 1) (got ${JSON.stringify(config.holdoutShare)})`);
    }
  }
  if (config.serviceModel) {
    parseModelRef(config.serviceModel, false);
  }

  // Typo protection: unknown top-level keys silently run with defaults on a
  // tool that spends real money — warn loudly instead.
  const KNOWN_KEYS = new Set([
    'name', 'seedPrompt', 'initialPrompts', 'testSet', 'models', 'serviceModel',
    'plugins', 'promptMode', 'samplesPerTest', 'holdoutShare', 'holdoutSeed',
    'pairwise', 'seed', 'callTimeoutMs', 'populationSize', 'generationSize',
    'maxGenerations', 'budget', 'targetFitness', 'timeLimitMs',
    'parallelLimit', 'serviceModelMaxTokens', 'retries', 'fitnessWeights',
    'operators', 'selection', 'systemPrompts', 'providerOptions',
    'costNorm', 'latencyNorm', 'guardrails',
    'openaiKey', 'anthropicKey', 'geminiKey', 'groqKey', 'openrouterKey',
  ]);
  for (const key of Object.keys(config)) {
    // `<provider>Key` is the documented way to supply a key for ANY provider,
    // including one a plugin registers — the CLI's own error message even tells
    // you to add "fakepKey". Warning that it is unknown contradicted that.
    // Case-SENSITIVE `Key`, matching what extractConfigKeys actually harvests.
    // The two were inverted: this shield whitelisted `openaikey` and `monkey`
    // (so no warning) while the harvester ignored them (so no key) — a real
    // credential sat in the config and the run died with "No API key found",
    // silently. Anything that is not harvested must be warned about.
    if (!KNOWN_KEYS.has(key) && !/^[a-zA-Z][a-zA-Z0-9]*Key$/.test(key)) {
      process.stderr.write(`warning: unknown config key "${key}" — ignored (typo?)\n`);
    }
  }

  // The same protection one level down. Warning only at the top level meant
  // `operators.mutationshare` or `testSet[0].expcted` produced NO warning at
  // all: the run used defaults, scored zero, and still cost full price.
  const warnUnknown = (obj: unknown, known: string[], path: string) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const allowed = new Set(known);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        process.stderr.write(`warning: unknown config key "${path}.${key}" — ignored (typo?)\n`);
      }
    }
  };
  warnUnknown(config.operators, [
    'mutationShare', 'crossoverShare', 'metaPrompting', 'paramVariation', 'modelVariation', 'custom', 'adaptivity',
  ], 'operators');
  warnUnknown(config.selection, ['policy', 'topK', 'topP', 'eliteShare', 'diversity', 'restartAfter', 'novelty'], 'selection');
  warnUnknown(config.fitnessWeights, ['quality', 'safety', 'cost', 'latency', 'stability'], 'fitnessWeights');
  warnUnknown(config.costNorm, ['mode', 'maxUSDPerCall'], 'costNorm');
  warnUnknown(config.latencyNorm, ['mode', 'maxMs'], 'latencyNorm');
  warnUnknown(config.pairwise, ['enabled', 'contenders'], 'pairwise');
  // `"pairwise": true` is the obvious shorthand and silently did nothing —
  // the engine tests `config.pairwise?.enabled === true`, so the playoff never
  // ran and no warning was printed.
  if (config.pairwise !== undefined && (typeof config.pairwise !== 'object' || config.pairwise === null || Array.isArray(config.pairwise))) {
    throw new Error(`"pairwise" must be an object like { "enabled": true, "contenders": 4 } (got ${JSON.stringify(config.pairwise)})`);
  }
  const TEST_KEYS = [
    'id', 'name', 'prompt', 'expected', 'mode', 'holdout', 'schema', 'tools',
    'expectedTool', 'grading', 'image',
  ];
  config.testSet.forEach((test, i) => {
    warnUnknown(test, TEST_KEYS, `testSet[${i}]`);
    // `weight` was in the accepted-keys list, so it passed validation in
    // silence — but quality is a plain unweighted average of test scores
    // (fitness.ts calculateQualityScore) and nothing ever read it. A user
    // weighting their most important test got no warning and no effect.
    if ((test as any).weight !== undefined) {
      console.warn(
        `[Config] testSet[${i}].weight is not implemented — every test contributes equally to quality. ` +
        `Remove it, or duplicate the test to weight it more heavily.`,
      );
    }
  });
}

export function toEvaluationConfig(config: CliConfig, configDir?: string): EvaluationConfig {
  // Explicit arrow, not .map(parseModelRef): map passes the index as the second
  // argument, which would land in checkProvider.
  const enabledModels: ModelRef[] = (config.models || ['openai/gpt-4o-mini']).map(m => parseModelRef(m));
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
      ...(t.holdout ? { holdout: true } : {}),
      grading: t.grading,
      ...(t.schema ? { schema: t.schema } : {}),
      ...(t.tools ? { tools: t.tools } : {}),
      ...(t.expectedTool ? { expectedTool: t.expectedTool } : {}),
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
      diversity: config.selection?.diversity ?? 0,
      novelty: config.selection?.novelty ?? 0,
      ...(config.selection?.restartAfter !== undefined ? { restartAfter: config.selection.restartAfter } : {}),
    },
    operators: {
      mutationShare: config.operators?.mutationShare ?? 0.5,
      crossoverShare: config.operators?.crossoverShare ?? 0.2,
      metaPrompting: config.operators?.metaPrompting ?? { enabled: true, share: 0.2 },
      modelVariation: config.operators?.modelVariation ?? { enabled: enabledModels.length > 1, share: 0.1 },
      paramVariation: config.operators?.paramVariation ?? { enabled: true, share: 0.1, temperature: { enabled: true, min: 0.3, max: 1.5 } },
      ...(config.operators?.custom ? { custom: config.operators.custom } : {}),
      adaptivity: config.operators?.adaptivity ?? 0,
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
    ...(config.promptMode ? { promptMode: config.promptMode } : {}),
    ...(config.samplesPerTest !== undefined ? { samplesPerTest: config.samplesPerTest } : {}),
    ...(config.holdoutShare !== undefined ? { holdoutShare: config.holdoutShare } : {}),
    ...(config.holdoutSeed !== undefined ? { holdoutSeed: config.holdoutSeed } : {}),
    ...(config.pairwise ? { pairwise: config.pairwise } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.callTimeoutMs !== undefined ? { callTimeoutMs: config.callTimeoutMs } : {}),
  };
}

/**
 * Extract inline API keys from CLI config (used for key resolution).
 */
export function extractConfigKeys(config: CliConfig): Record<string, string> {
  const keys: Record<string, string> = {};
  // ANY `<something>Key` field, not just the five built-ins. The docs and the
  // missing-key error both tell users to put `"<provider>Key"` in the config,
  // but a hardcoded list made that a silent no-op for every plugin provider —
  // the advice named a field the loader never read.
  for (const [field, value] of Object.entries(config)) {
    // Case-SENSITIVE on the `Key` suffix. A case-insensitive suffix would drag
    // in ordinary words — `monkey`, `turkey` — and put them in what is
    // effectively a credential map. `openAIKey` is covered because it does end
    // in `Key`; the resolver then matches it case-insensitively.
    if (/^[A-Za-z0-9_-]+Key$/.test(field) && typeof value === 'string' && value) {
      keys[field] = value;
    }
  }
  return keys;
}
