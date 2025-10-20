# Prompt Evolution (JS/TS, Electron) — Technical Spec & LLM Build Brief (V1)

> Desktop app that **evolves prompts** via genetic operators (mutation, crossover, optional meta-prompting), evaluates candidates across a **test set** with a configurable **fitness** (quality, safety, stability, cost, latency), and **visualizes generations** as a scrollable lineage graph. Includes caching, early stop, budget/time/score ceilings, and JSON execution logs (export/import).  
> **V1 Simplifications:** **No NSGA-2**, **Per-Model Cost Overrides**, **Persist once per generation**, **Levenshtein text distance** included.

---

## 1) Product Overview

**Users**: Prompt engineers, QA leads, founders tuning LLM agents.  
**Core Loop**: Configure → Generate initial population → Evaluate (parallel, up to global limit) → Select top share (Top-K/Top-P) → Produce next generation via mutations/crossover/meta → Repeat until stop (time, spend, target score).  
**Non-Goals**: Cloud multi-tenancy, team collaboration, server deploy. **Offline desktop**; users bring their own API keys.

---

## 2) Tech Stack

- **Frontend**: Electron + React (Vite), TypeScript, Zustand (state), React Query (async/cache), Tailwind (UI), D3 (graph), shadcn/ui
- **Backend (in-app)**: Node.js (TS), worker threads/child_process for evaluation runners
- **Persistence**: SQLite (better-sqlite3) + JSON export/import; secrets in OS keychain (keytar)
- **LLM Providers**: OpenAI, Anthropic, Google Gemini via pluggable adapters; token counting via provider SDKs / tiktoken / heuristics
- **IPC**: Electron `ipcMain`/`ipcRenderer`; all network calls from main/worker (not renderer)

---

## 3) High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Electron Main Process                       │
│  • Orchestrator (GA Engine + Scheduler)                              │
│  • Evaluation Queue + Rate Limiter + Budget Guard                    │
│  • Provider Adapters (OpenAI/Anthropic/Gemini)                       │
│  • Cost/Token Accounting + Cache + Early Stop                        │
│  • Persistence (SQLite) + JSON Import/Export                         │
│  • Worker Pool (N parallel)                                          │
│  • IPC API (secure)                                                  │
└───────────────▲───────────────────────────────────────────▲──────────┘
                │                                           │
      Renderer  │                                   Worker Threads
                │
┌───────────────┴───────────────────────────────────────────┴──────────┐
│                             Renderer (React)                          │
│  • Left Sidebar: logo, New Evaluation, list of evaluations, Settings  │
│  • Center: Generation timeline (scrollable), graph edges/nodes        │
│  • Footer: status, stop reason, pause/resume/stop, gen#, spend        │
│  • Right Panel: node details (prompt, changes, tests & results)       │
└───────────────────────────────────────────────────────────────────────┘
```

**Security**: API keys via keytar; never stored in plain text. Renderer never holds raw keys.

---

## 4) UI / UX Requirements

### 4.1 Left Sidebar
- Logo; **New Evaluation** button
- Evaluations list with status (running/paused/stopped/finished), best score, last run
- **Settings** pinned at bottom

### 4.2 Center (Generations)
- Vertical timeline (older at top → newer below); each generation has distinct background shade
- Node cards (rectangles); edges connect to parents
- Highlight **top-3** per generation (gold/silver/blue)

### 4.3 Node Card (summary)
- Node ID; Status badge (Awaiting/In-Progress/Finished/Failed)
- Prompt preview (start, `…` elided)
- Footer: elapsed time (live if running), **fitness**, **temperature**, **model**

### 4.4 Right Sidebar (details)
- Close (×); chips: **ID, status, model, temperature, time, score**
- **Prompt & Params**: scrollable prompt (read-only), parameters (model, temperature, seed), copy button
- **Change Log**: numbered, scrollable; labels `[MUTATION]`, `[CROSSOVER]`, `[META]`, `[PARAM]`
- **Tests**: summary `passed/total`; expand to show test prompt, completion text, evaluation score/boolean, **tokens (prompt/completion)**, and optional raw provider response

### 4.5 Footer
- Status (running / paused / stopped reason: *time*, *budget*, *target fitness*)
- Controls: **Pause/Resume**, **Stop**
- **Generation #**, **total tokens**, **estimated $ spend**

### 4.6 Settings
- **Service Model** (for meta/mutation/crossover/test evaluation)
- API keys: **OpenAI**, **Anthropic**, **Gemini** (keytar)
- **Global Parallelism Limit** (N). Optional per-provider concurrency
- **Per-Model Cost Table**: editable $/1k prompt & $/1k completion per model; stored in SQLite; used for estimates/accounting
- Optional: per-provider rate limits (RPM/TPM) & budget caps

### 4.7 New Evaluation Modal (Tabbed)
1) **Main** — Name; **Mutation factor** (0..1); **Crossover factor** (0..1); **Temp variations** toggle + bounds + share; **Meta-prompting** toggle + share (default 0.2); **Selection**: **Top-K** or **Top-P**
2) **Population & Prompt** — Initial size (default 10); seed prompt; fill: **auto** (mutate via service model) or **manual**; optional per-candidate initial model
3) **Enabled Models** — Multi-select across providers (show context window & cost hint)
4) **Test Set** — Mode A: **LLM-graded** (1..10) via rubric; Mode B: **Exact-match** (number/JSON/string) with strict 0/10 **or graded distance** (Levenshtein/json_diff/numeric_abs); multiple tests; optional generation via service model
5) **Fitness Function** (scalar) — Weights for **quality (required)**, **safety**, **cost**, **latency**, **stability** (optional); weights auto-normalize to sum=1; show formula preview
6) **Targets** — **Time** limit, **Budget** limit ($), **Target fitness ≥** (at least one required)
7) **Start** — Validate required fields; highlight missing; enable **Start**

---

## 5) Data Model (TypeScript)

```ts
export type UUID = string;
export type Provider = 'openai' | 'anthropic' | 'gemini';

export interface ModelRef {
  provider: Provider;
  model: string; // e.g., 'gpt-4.1', 'claude-3-5-sonnet', 'gemini-1.5-pro'
}

export type NodeStatus = 'awaiting' | 'in_progress' | 'finished' | 'failed' | 'skipped';

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
  rawResponsePath?: string; // persisted blob if raw capture enabled
  outputText?: string;
}

export interface CandidateParams {
  model: ModelRef;
  temperature: number; // 0..2
  seed?: number;       // for stability runs
}

export type ChangeLabel = 'MUTATION' | 'CROSSOVER' | 'META' | 'PARAM';

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
    topShare: number;     // e.g., 0.4
    policy: 'topk' | 'topp';
    topK?: number;        // when policy = 'topk'
    topP?: number;        // when policy = 'topp' (0..1 proportion)
  };
  operators: {
    mutationFactor: number; // 0..1
    crossoverFactor: number; // 0..1
    paramVariation?: { enabled: boolean; temperature: { min: number; max: number }; share: number };
    metaPrompting?: { enabled: boolean; share: number }; // default 0.2
  };
  population: {
    size: number; // default 10
    seedPrompt: string;
    fill: 'auto' | 'manual';
  };
  enabledModels: ModelRef[];
  testSet: TestCase[];
  fitness: {
    weights: { quality: number; safety?: number; cost?: number; latency?: number; stability?: number };
    guardrails?: string[]; // prompts for safety checks
    costNorm?: { maxUSDPerCall: number };
    latencyNorm?: { maxMs: number };
  };
  targets: { timeLimitMs?: number; budgetUSD?: number; targetFitness?: number };
  serviceModel: ModelRef; // for meta/mutation/crossover/grading
  parallelLimit: number;  // global N
  rawBlobCapture?: boolean; // default false
}

export interface EvaluationRun {
  id: UUID;
  configId: UUID;
  startedAt: number;
  finishedAt?: number;
  stopReason?: 'time' | 'budget' | 'target' | 'manual' | 'exhausted' | 'error';
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  generations: CandidateNode[][]; // 2D grid
  cacheHits: number;
  version: string; // schema version
}
```

---

## 6) Algorithms & Operators

### 6.1 Scheduling & Parallelism
- Work queue of `"awaiting"` nodes; up to `parallelLimit` in workers
- On node finish, enqueue next; UI gets progress via IPC stream
- Per-provider **rate limiting** (RPM/TPM) + exponential backoff & jitter on 429/5xx

### 6.2 Fitness Calculation (Scalar)
- **Quality**
    - Mode A (**LLM-graded**): rubric yields 1..10
    - Mode B (**Exact-match**): strict **0/10** or **graded distance** (see below)
- **Safety**: average of guardrail checks (0..10)
- **Cost**: raw USD → normalize `[0..1]` via `costNorm.maxUSDPerCall`; use `(1 - cost_norm)`
- **Latency**: ms → normalize `[0..1]` via `latencyNorm.maxMs`; use `(1 - latency_norm)`
- **Stability**: run k seeds (e.g., 3); inverse variance → 0..10 (default k=1 → effectively off)
- **Scalar fitness**
  ```
  fitness = wq*Quality + ws*Safety + wst*Stability + wc*(1 - CostNorm) + wl*(1 - LatencyNorm)
  ```
  Weights auto-normalize to sum=1 as terms are enabled/disabled

#### Levenshtein normalization (text distance)
Let `gold`, `pred` be strings.
- Edit distance `d = levenshtein(gold, pred)`
- `L = max(1, max(len(gold), len(pred)))`
- Similarity `s = clamp(1 - d/L, 0, 1)`
- Score `0..10`: `score = round(10 * s)`

```ts
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
export function levenshteinScore0to10(gold: string, pred: string): number {
  const L = Math.max(1, Math.max(gold.length, pred.length));
  const d = levenshtein(gold, pred);
  const s = Math.max(0, 1 - d / L);
  return Math.round(10 * s); // 0..10
}
```

#### JSON distance (`json_diff`)
- Parse both as JSON. Count structural diffs `nDiff`. Let `N = max(1, totalNodes(gold))`.
- Score = `round(10 * (1 - clamp(nDiff/N, 0, 1)))`.

#### Numeric distance (`numeric_abs`)
- If both parse to numbers, `Δ = |pred - gold|`. With tolerance `T` (default `max(1, |gold|*0.05)`):  
  `score = round(10 * (1 - clamp(Δ / (T + Δ), 0, 1)))`.
- If parse fails → score = 0.

### 6.3 Selection (V1)
- Sort by scalar fitness; take top proportion `selection.topShare`
- Optional diversity: randomly reserve (e.g., +10%) from remainder

### 6.4 Variation Operators
- **Mutation** (1–3 small edits): structure, content, formatting, compression, regularizers → record `[MUTATION]`
- **Crossover** (one): section splice; or ensemble distill → record `[CROSSOVER]`
- **Meta-prompting**: targeted edits based on failures (default OFF) → record `[META]`
- **Param Variation**: temperature bounds to a share → record `[PARAM]`
- **Operator effectiveness (logging)**: log average Δfitness per operator over last M gens (no policy change in V1)

### 6.5 Early Stop & Branch Pruning
- Stop on time/budget/fitness or manual stop
- Prune lineages with **no improvement K generations** (mark **skipped** unless re-selected as elite)

### 6.6 Caching
- Key = hash of `(prompt, model, temperature, testSet signature)`
- On hit: reuse test results/tokens/latency/cost; mark node finished; increment `cacheHits`

---

## 7) Provider Abstraction

```ts
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
    rawPath?: string; // if rawBlobCapture enabled
  }>;
}
```

- Maintain **Per-Model Cost Table** ($/1k prompt & completion); editable in Settings
- Retries, timeouts, structured errors

---

## 8) IPC API (Renderer ⇄ Main)

- `eval.create(config: EvaluationConfig): Promise<EvaluationRun>`
- `eval.start(runId)`, `eval.pause(runId)`, `eval.resume(runId)`, `eval.stop(runId)`
- `eval.subscribe(runId, cb)` → stream: node updates, totals, stopReason
- `eval.list(): Promise<EvaluationRun[]>`
- `eval.export(runId): Promise<string /*filePath*/>`
- `eval.import(filePath): Promise<EvaluationRun>`
- `settings.get()/set()`, `keys.save({provider, key})`, `keys.test(provider)`
- `costs.get(modelRef)`, `costs.set(modelRef, {promptUSDper1k, completionUSDper1k})`

All IPC validated (zod). Streams are one-way to avoid re-entrancy.

---

## 9) Persistence & Files

- SQLite: `EvaluationConfig`, `EvaluationRun`, `CandidateNode`, `TestCase`, `Blob` (raw responses), `CostLedger`, `ModelCosts`
- **Write policy (V1)**: **persist once per generation** (atomic batch snapshot); in-memory state during generation
- **JSON export** mirrors `EvaluationRun` (+ configs, optional raw blobs)
- **Raw blob capture** (default OFF): store provider raw responses on disk, reference via `rawResponsePath`
- Schema versioning + migrations

---

## 10) Service Model Templates

### 10.1 LLM-Graded Quality
```
SYSTEM: You are a strict evaluator. Return ONLY a JSON object.
USER: Rubric (1..10):
- Task completion accuracy
- Format compliance
- Hallucination avoidance
- Brevity & clarity

Given:
PROMPT (candidate): <<<\n{candidate_prompt}\n>>>
INPUT (test): <<<\n{test_prompt}\n>>>
OUTPUT (model): <<<\n{model_output}\n>>>

Return:
{"score": <number 1..10>, "justification": "<one sentence>"}
```

### 10.2 Safety Guardrail Check
```
SYSTEM: You are a safety checker. Return ONLY JSON.
USER: Guardrail: "{guardrail_text}"
OUTPUT: <<<\n{model_output}\n>>>
Return: {"score": <0..10>, "violations": ["..."]}
```

### 10.3 Mutation Operator
```
SYSTEM: You propose SMALL, PRECISE edits to improve a prompt.
USER: Candidate prompt: <<<\n{prompt}\n>>>
Make 1–3 minimal edits chosen from: structure, content, formatting, compression, regularizers.
Return JSON list of edits: [{"label":"MUTATION","edit":"..."}]
```

### 10.4 Apply Edits
```
SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<\n{prompt}\n>>>
Edits: {json_edits}
Produce the NEW prompt ONLY.
```

### 10.5 Crossover (Distill or Splice)
```
SYSTEM: Merge best parts of A and B into a coherent prompt without redundancy.
USER: A: <<<\n{promptA}\n>>>\nB: <<<\n{promptB}\n>>>
Return the merged prompt ONLY.
```

### 10.6 Meta-Prompting (Targeted Edits)
```
SYSTEM: You are a prompt surgeon. Suggest surgical changes based on failures.
USER: Parent Prompt: <<<\n{parent}\n>>>
Top failures (3): {summary}
Hard constraints: {constraints}
Return JSON edits: [{"label":"META","edit":"..."}]
```

---

## 11) State Machines

**Node**
```
awaiting -> in_progress -> finished
                      ↘ failed (retry <= R) -> awaiting | failed
```

**Run**
```
running ↔ paused → stopped(reason) | finished(target/time/budget)
```

**Generation Commit**
```
(per-node updates stream to UI) → when all nodes in Gen N finish
→ compute rankings/top-share → persist single batch snapshot
→ spawn Gen N+1
```

---

## 12) Cost & Budgeting

- **CostLedger** per provider call (prompt/completion tokens, $)
- Running totals in footer; **budget guard** checks before enqueue
- Currency USD; costs from **Per-Model Cost Table** (overridable)

---

## 13) Testing & Reliability

- Unit: operator logic, weight normalization, cache keys, selection logic
- Integration: provider adapters (mockable HTTP), timeout/retry paths
- Snapshot: execution JSON snapshots for small E2E runs
- Determinism: optional fixed `seed` where supported

---

## 14) Performance Targets

- Handle ~1k nodes without UI jank (virtualized lists)
- Worker pool reuse; avoid cold starts; batch where allowed
- D3 edges layered to minimize reflow

---

## 15) Security & Privacy

- API keys in OS keychain (keytar); redact in logs/exports
- Export option to **exclude raw outputs** (scores/metrics only)

---

## 16) CLI (Optional)

- `peval run --config config.json --out run.json` (headless for CI)

---

## 17) Acceptance Criteria (DoD)

- Create, run, pause/resume, stop evaluations
- Visual generations with node statuses & top-3 highlighting
- Right panel shows prompt, change log, tests, tokens, outputs
- Fitness function configurable (scalarization only); **Top-K/Top-P** selection
- Targets (time/budget/fitness) stop runs; reason displayed
- Caching, branch pruning, **per-model cost overrides**
- **Persist once per generation**; JSON import/export; schema versioned
- Works with OpenAI/Anthropic/Gemini; rate-limit safe

---

## 18) Milestones

1. Scaffold Electron + React + TS + SQLite + keytar + shadcn + D3
2. Provider adapters + token/cost accounting + retries + **Per-Model Cost Table UI & IPC**
3. Data model + migrations + export/import
4. Runner (queue, pool, rate limits, budget guard, caching)
5. Fitness compute (LLM-grade, exact-match incl. Levenshtein/json_diff/numeric, guardrails, stability seeds)
6. Operators (mutation, crossover, meta, param variation) + templates
7. UI (sidebar, timeline, nodes, right panel, footer, settings, new eval modal)
8. Selection (Top-K/Top-P) + **operator effectiveness logging**
9. Polish (virtualization, perf, error surfaces) + test suite
