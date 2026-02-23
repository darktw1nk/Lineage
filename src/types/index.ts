// Core Types for Prompt Evolution Application

export type UUID = string;
export type Provider = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

export interface ModelRef {
  provider: Provider;
  model: string; // e.g., 'gpt-4', 'claude-3-5-sonnet', 'gemini-1.5-pro'
}

export type NodeStatus = 'awaiting' | 'pending' | 'in_progress' | 'finished' | 'failed' | 'skipped';

export interface TestCase {
  id: UUID;
  name: string;
  mode: 'llm_grade' | 'exact_match';
  prompt: string;
  expected?: string; // for exact_match; may be number/JSON as string
  grading?: {
    strictZeroOnDeviation?: boolean; // if true, non-equal => 0 else distance-graded
    distanceMetric?: 'levenshtein' | 'json_diff' | 'numeric_abs';
  };
}

export interface TestResult {
  testId: UUID;
  passed: boolean;
  score: number; // 0..10
  promptTokens: number;
  completionTokens: number;
  latencyMs: number; // execution time for this test
  rawResponsePath?: string; // persisted blob if raw capture enabled
  outputText?: string;
  llmGradeReasoning?: string; // raw LLM judge response for llm-graded tests
}

export interface CandidateParams {
  model: ModelRef;
  temperature: number; // 0..2
  seed?: number;       // for stability runs
}

export type ChangeLabel = 'MUTATION' | 'CROSSOVER' | 'META' | 'PARAM' | 'MODEL' | 'ELITE' | 'CARRY' | 'ERROR';

export interface ChangeLogLine {
  label: ChangeLabel;
  text: string; // human-readable delta
}

export interface CandidateNode {
  id: UUID;
  generation: number;
  lineageParents: UUID[]; // 0, 1 or 2 parents
  status: NodeStatus;
  prompt: string;
  params: CandidateParams;
  changeLog: ChangeLogLine[]; // diffs from parents
  timings?: { startedAt?: number; finishedAt?: number };
  tests?: TestResult[];
  metrics?: {
    quality?: number;   // 0..10
    safety?: number;    // 0..10 average across guardrails
    costUSD?: number;   // raw USD per candidate
    latencyMs?: number;
    stability?: number; // 0..10 (higher = more stable)
    fitness?: number;   // scalar fitness
  };
  error?: string;
}

export interface EvaluationConfig {
  id: UUID;
  name: string;
  selection: {
    policy: 'topk' | 'topp';
    topK?: number;        // when policy = 'topk': fixed number (e.g., 4)
    topP?: number;        // when policy = 'topp': cumulative probability (0..1, e.g., 0.8)
    eliteShare?: number;  // 0..1: fraction of generation to preserve from previous generation (default 0.05 = 5%)
  };
  operators: {
    mutationShare: number; // 0..1, renamed from mutationFactor
    crossoverShare: number; // 0..1, renamed from crossoverFactor
    metaPrompting?: { enabled: boolean; share: number }; // default 0.2
    modelVariation?: { enabled: boolean; share: number }; // random model selection
    paramVariation?: { 
      enabled: boolean; 
      share: number; // param variation share (temperature, etc.)
      temperature?: { enabled: boolean; min: number; max: number };
    };
  };
  population: {
    initialSize: number; // size of generation 0 (default 10)
    generationSize: number; // size of subsequent generations (default 10)
    seedPrompt: string;
    fill: 'auto' | 'manual';
  };
  enabledModels: ModelRef[];
  testSet: TestCase[];
  fitness: {
    weights: { quality: number; safety?: number; cost?: number; latency?: number; stability?: number };
    guardrails?: string[]; // prompts for safety checks
    costNorm?: { mode: 'absolute' | 'relative'; maxUSDPerCall: number };
    latencyNorm?: { mode: 'absolute' | 'relative'; maxMs: number };
  };
  targets: { timeLimitMs?: number; budgetUSD?: number; targetFitness?: number; maxGenerations?: number };
  serviceModel: ModelRef; // for meta/mutation/crossover/grading
  parallelLimit: number;  // global N
  serviceModelMaxTokens: number; // Max tokens for ALL model calls (service + candidate)
  retries: number; // Number of retry attempts for JSON parsing failures (copied from global settings)
}

export interface EvaluationRun {
  id: UUID;
  configId: UUID;
  startedAt: number;
  finishedAt?: number;
  stopReason?: 'time' | 'budget' | 'target' | 'manual' | 'exhausted' | 'error' | 'generations';
  status?: 'running' | 'paused' | 'stopped' | 'pausing' | 'finished';
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  generations: CandidateNode[][]; // 2D grid
  cacheHits: number;
  version: string; // schema version
  totalPausedMs?: number; // Total time spent paused (for accurate elapsed time display)
  pausedAt?: number; // Timestamp when currently paused (if status is 'paused')
}

export interface ModelCostEntry {
  provider: Provider;
  model: string;
  promptUSDper1k: number;
  completionUSDper1k: number;
}

export interface AppSettings {
  globalParallelLimit: number;
  perProviderLimits?: {
    openai?: { rpm?: number; tpm?: number };
    anthropic?: { rpm?: number; tpm?: number };
    gemini?: { rpm?: number; tpm?: number };
    openrouter?: { rpm?: number; tpm?: number };
  };
  serviceModel: ModelRef;
  serviceModelMaxTokens: number; // Max tokens for service model calls (mutations, grading, safety)
  retries: number; // Global retry limit for JSON parsing and other non-network failures (default: 3)
}

// Provider Adapter Interface
export interface ProviderAdapter {
  name: Provider;
  estimateTokens(input: string): { prompt: number; completion?: number };
  call(opts: {
    model: string;
    prompt: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    usd: number;
  }>;
}

// IPC Event Types
export interface NodeUpdateEvent {
  runId: UUID;
  node: CandidateNode;
}

export interface TotalsUpdateEvent {
  runId: UUID;
  totals: {
    tokensPrompt: number;
    tokensCompletion: number;
    usd: number;
    calls: number;
  };
  cacheHits: number;
}

export interface StopEvent {
  runId: UUID;
  reason: 'time' | 'budget' | 'target' | 'manual' | 'exhausted' | 'error';
  error?: string;
}

