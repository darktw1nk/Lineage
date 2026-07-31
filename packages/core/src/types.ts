// Core Types for Prompt Evolution Application

export type UUID = string;
export type Provider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | (string & {});

export interface ModelRef {
  provider: Provider;
  model: string; // e.g., 'gpt-4', 'claude-3-5-sonnet', 'gemini-1.5-pro'
}

export type NodeStatus = 'awaiting' | 'pending' | 'in_progress' | 'finished' | 'failed' | 'skipped';

export interface TestCase {
  id: UUID;
  name: string;
  mode: 'llm_grade' | 'exact_match' | 'json_schema' | 'tool_call';
  prompt: string;
  expected?: string; // for exact_match; may be number/JSON as string
  image?: string; // absolute path to image file for vision-enabled tests
  holdout?: boolean; // excluded from fitness; used for the final generalization report
  grading?: {
    strictZeroOnDeviation?: boolean; // if true, non-equal => 0 else distance-graded
    distanceMetric?: 'levenshtein' | 'json_diff' | 'numeric_abs';
  };
  schema?: object; // json_schema mode: JSON Schema the output must conform to
  tools?: ToolDef[]; // tool_call mode: tools offered to the candidate model
  expectedTool?: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' }; // tool_call mode
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
  samples?: number[]; // individual sample scores when samplesPerTest > 1
  /**
   * The judge could not be read, so `score` is a placeholder 5.0, not a
   * measurement. Only the run-level `ungradedTests` count existed before, so
   * results.json showed a bare `"score": 5` indistinguishable from a judge that
   * genuinely said 5 — while the report told readers the leaf was the honest
   * record. Absent on a graded test rather than `false`.
   */
  ungraded?: boolean;
}

export interface CandidateParams {
  model: ModelRef;
  temperature: number; // 0..2
  seed?: number;       // for stability runs
}

export type ChangeLabel = 'MUTATION' | 'CROSSOVER' | 'META' | 'PARAM' | 'MODEL' | 'ELITE' | 'CARRY' | 'ERROR' | (string & {});

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
    playoffRank?: number; // 1-based rank from this generation's pairwise playoff
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
    custom?: Record<string, { enabled?: boolean; share: number }>; // plugin operator shares, keyed by operator name
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
  providerOptions?: Record<string, any>; // Extra options passed to candidate model calls (e.g. reasoning_effort)
  promptMode?: 'system' | 'inline'; // default 'system': candidate prompt as system message
  samplesPerTest?: number;          // default 1 (clamped 1..10): samples averaged per test
  holdoutShare?: number;            // default 0: seeded share of non-flagged tests held out
  holdoutSeed?: number;             // default 42: PRNG seed for the share split
  pairwise?: { enabled: boolean; contenders?: number }; // opt-in playoff; contenders default 4, clamped 2..8
  seed?: number; // run-level reproducibility seed (engine decisions + derived candidate seeds)
  callTimeoutMs?: number; // per-attempt LLM call timeout in ms (default 120000)
}

export interface EvaluationRun {
  id: UUID;
  configId: UUID;
  startedAt: number;
  finishedAt?: number;
  /** When the run was last checkpointed. Used to credit process downtime against timeLimitMs on resume. */
  lastCheckpointAt?: number;
  /** Set when holdoutShare was requested but produced no held-out tests. */
  holdoutSkippedReason?: 'share-rounds-to-zero';
  stopReason?: 'time' | 'budget' | 'target' | 'generations' | 'manual' | 'exhausted' | 'error';
  status?: 'running' | 'paused' | 'stopped' | 'pausing' | 'finished';
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  generations: CandidateNode[][]; // 2D grid
  cacheHits: number;
  /**
   * Test results whose judge reply could not be parsed and were scored 5.0.
   * 5.0 looks like a grade, so without a count the report presents fabricated
   * numbers as measured ones.
   */
  ungradedTests?: number;
  holdout?: {
    testIds: UUID[];
    samplesPerTest: number;
    seed?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
    champion?: { score: number; perTest: Array<{ testId: UUID; score: number }> };
    // 'error' and 'time': a run aborted by the grading circuit breaker must not
    // pay for a holdout judged by the same model it just declared unusable, and
    // a time limit is a ceiling like a budget.
    skipped?: 'budget' | 'no-champion' | 'manual' | 'error' | 'time';
  };
  /**
   * Pairwise playoff rankings, best first.
   *
   * `decisive` is whether the top two were separated by a clear win. A
   * non-decisive playoff is a coin flip and must NOT pick the champion or
   * override fitness — it is kept only so the report can show what was judged.
   * Absent on runs checkpointed before the flag existed; treat as decisive
   * there, which is what those runs actually did.
   */
  playoffs?: Array<{ generation: number; ranking: UUID[]; decisive?: boolean }>;
  costBreakdown?: Record<string, { calls: number; promptTokens: number; completionTokens: number; usd: number }>; // COST_LABELS keys + model:<provider>/<model> keys
  pricingUnknown?: string[]; // models with no catalogued price: their calls count as $0, so spend is a lower bound
  estimate?: { calls: number; low: number; high: number; breakdown: Array<{ label: string; calls: number; low: number; high: number }> }; // preflight snapshot
  /**
   * Fingerprint of the system prompts (grading rubric, mutation strategies,
   * judge instructions) in force when the run started. A resume that resolves
   * DIFFERENT prompts is refused: scores from two rubrics are not comparable,
   * and selection/elitism/champion choice would silently mix them.
   */
  graderFingerprint?: string;
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

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------

export interface OperatorContext {
  parent: CandidateNode;
  parentB?: CandidateNode;          // present when the operator declares parents: 2
  config: EvaluationConfig;
  generation: CandidateNode[];      // current generation snapshot
  rng?: () => number;               // deterministic when the run is seeded; use instead of Math.random
  /**
   * Budget/stop gate for multi-call operators. `spentSoFarUSD` is what THIS
   * operator has already billed (not yet settled into run totals). Check it
   * between service calls and stop retrying when it returns true — the host
   * only gates the first call, so an operator that ignores this can bill its
   * whole retry ceiling past budgetUSD (pass 19: measured 2×retries calls
   * behind one settled-spend check).
   */
  shouldAbort?: (spentSoFarUSD?: number) => boolean;
}

export interface OperatorResult {
  prompt: string;
  params?: Partial<CandidateParams>;  // optional patch (temperature, seed, model)
  changeLog: ChangeLogLine[];
  cost: { promptTokens: number; completionTokens: number; usd: number; calls: number };
}

export interface OperatorPlugin {
  name: string;                     // unique id: config share key, changelog source, effectiveness key
  label?: string;                   // display name (UI)
  description?: string;
  parents: 1 | 2;                   // unary (mutation-like) or binary (crossover-like)
  apply(ctx: OperatorContext): Promise<OperatorResult>;
}

export interface ProviderPlugin {
  adapter: ProviderAdapter;         // adapter.name is the provider id
  models?: ModelCostEntry[];        // upserted into model_costs at registration (per-1k pricing)
}

export interface PluginManifest {
  name: string;
  version?: string;
  source: string;                   // absolute path of the loaded module
  operators: string[];              // operator names contributed
  providers: string[];              // provider ids contributed
  error?: string;                   // set when the module failed to load/validate
}

export interface AppSettings {
  globalParallelLimit: number;
  serviceModel: ModelRef;
  serviceModelMaxTokens: number; // Max tokens for service model calls (mutations, grading, safety)
  retries: number; // Global retry limit for JSON parsing and other non-network failures (default: 3)
}

// Provider Adapter Interface
// Canonical tool definition (OpenAI function shape); adapters translate per provider
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: object;
}

export interface ProviderAdapter {
  name: Provider;
  /**
   * Whether hosts should refuse to start a run without an API key for this
   * provider. The five built-in adapters set it; a plugin provider opts in.
   *
   * Default is NO requirement, because a host cannot know a third-party
   * provider's auth model — it may talk to a local server, read its own env
   * var, or need nothing at all. Assuming a key was required refused to start
   * any run using the shipped Ollama example, whose own header says "No API
   * key needed", with `No API key found for provider: ollama`.
   */
  requiresApiKey?: boolean;
  /**
   * Whether this adapter actually FORWARDS `seed` to the provider.
   *
   * Defaults to true (treat the seed as meaningful). An adapter that accepts
   * `seed` in its options and drops it must set this false, or the seed
   * partitions the result cache while being unable to change any output —
   * pure lost dedup. Anthropic is the case in point.
   */
  supportsSeed?: boolean;
  estimateTokens(input: string): { prompt: number; completion?: number };
  call(opts: {
    model: string;
    prompt: string;
    system?: string; // sent via the provider's native system mechanism when present
    temperature: number;
    seed?: number;
    maxTokens?: number;
    timeoutMs?: number; // per-attempt abort timeout; absent/<=0 => 120s default
    tools?: ToolDef[]; // tool_call tests: offered to the model, translated per provider
    providerOptions?: Record<string, any>;
    images?: Array<{ base64: string; mimeType: string }>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    usd: number;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; // present only when the model called tools
    truncated?: boolean; // the token cap ended the reply, not the model — see BaseProviderAdapter.callAPI
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
  reason: 'time' | 'budget' | 'target' | 'generations' | 'manual' | 'exhausted' | 'error';
  error?: string;
}

