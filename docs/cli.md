# PromptEngine.AI — CLI Reference

## Install

- **From this repo**: `npm run cli -- <options>` (runs from source via tsx).
- **As a package** (not yet published to npm): install `@promptengine/core` + `@promptengine/cli` tarballs (`npm pack` in each package), then use `npx promptengine <options>`.

## Usage

```bash
npm run cli -- --config <path>              # Run evolution from JSON config
npm run cli -- --output <path>              # Write JSON results to file (default: stdout)
npm run cli -- --db <path>                  # Use a specific database file
npm run cli -- --sync-models                # Sync models from OpenRouter
npm run cli -- --list-models                # List all models with pricing
npm run cli -- --set-key <provider> <key>   # Save API key (shared with desktop app)
npm run cli -- --help                       # Show help
```

Progress is written to stderr, JSON result to stdout. Pipe with `2>/dev/null` for clean JSON output.

---

## Config File

All evolution settings are specified in a single JSON file passed via `--config`.

### Minimal Example

```json
{
  "seedPrompt": "You are a helpful assistant that answers math questions step by step.",
  "testSet": [
    { "prompt": "What is 2+2?", "expected": "4", "mode": "exact_match" },
    { "prompt": "Explain why the sky is blue." }
  ]
}
```

### Full Example

```json
{
  "name": "Math Tutor Evolution",
  "seedPrompt": "You are a helpful math tutor.",
  "models": ["openai/gpt-4o", "anthropic/claude-sonnet-4-5-20250929"],
  "serviceModel": "openai/gpt-4o-mini",
  "populationSize": 8,
  "generationSize": 8,
  "maxGenerations": 5,
  "budget": 2.00,
  "targetFitness": 9.0,
  "timeLimitMs": 300000,
  "parallelLimit": 10,
  "serviceModelMaxTokens": 20000,
  "retries": 3,
  "testSet": [
    {
      "name": "Basic arithmetic",
      "prompt": "What is 17 * 23?",
      "expected": "391",
      "mode": "exact_match",
      "grading": { "strictZeroOnDeviation": false, "distanceMetric": "numeric_abs" }
    },
    {
      "name": "Explanation quality",
      "prompt": "Explain the Pythagorean theorem to a 10-year-old.",
      "mode": "llm_grade"
    }
  ],
  "fitnessWeights": {
    "quality": 1.0,
    "safety": 0.5,
    "cost": 0.1,
    "latency": 0.1,
    "stability": 0.3
  },
  "guardrails": ["Must not include profanity", "Must not hallucinate formulas"],
  "costNorm": { "mode": "absolute", "maxUSDPerCall": 0.05 },
  "latencyNorm": { "mode": "absolute", "maxMs": 5000 },
  "selection": {
    "policy": "topk",
    "topK": 3,
    "eliteShare": 0.05
  },
  "operators": {
    "mutationShare": 0.5,
    "crossoverShare": 0.2,
    "metaPrompting": { "enabled": true, "share": 0.2 },
    "modelVariation": { "enabled": true, "share": 0.1 },
    "paramVariation": {
      "enabled": true,
      "share": 0.1,
      "temperature": { "enabled": true, "min": 0.3, "max": 1.5 }
    }
  },
  "openaiKey": "sk-...",
  "anthropicKey": "sk-ant-...",
  "systemPrompts": {
    "llmGradingPrompt": "You are a strict evaluator. Score 0-10..."
  }
}
```

### Manual Initial Population

Instead of `seedPrompt` (which auto-generates variants), you can provide explicit starting prompts:

```json
{
  "initialPrompts": [
    "You are a concise math tutor. Show only the final answer.",
    "You are a detailed math tutor. Show every step.",
    "You are a Socratic math tutor. Ask guiding questions."
  ],
  "testSet": [...]
}
```

When `initialPrompts` is set, `populationSize` is ignored (population size = array length).

---

## Config Fields Reference

### Required Fields

| Field | Type | Description |
|---|---|---|
| `seedPrompt` or `initialPrompts` | string / string[] | Starting prompt(s). One is required. |
| `testSet` | array | Non-empty array of test cases. |

### Models

| Field | Type | Default | Description |
|---|---|---|---|
| `models` | string[] | `["openai/gpt-4o-mini"]` | Candidate execution models. Format: `"provider/model"`. |
| `serviceModel` | string | first of `models` | Model for grading, mutations, crossover, meta-prompting. |
| `serviceModelMaxTokens` | number | `20000` | Max tokens for all model calls. |

Valid providers: `openai`, `anthropic`, `gemini`, `openrouter`.

### Population & Generations

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"CLI Evolution"` | Run name (stored in DB). |
| `populationSize` | number | `6` | Generation 0 size. Ignored if `initialPrompts` set. |
| `generationSize` | number | `populationSize` | Size of subsequent generations. |

### Stop Conditions

The evolution stops when any condition is met:

| Field | Type | Default | Description |
|---|---|---|---|
| `maxGenerations` | number | `3` | Maximum number of generations. |
| `budget` | number | none | Maximum spend in USD. |
| `targetFitness` | number | none | Stop when best fitness reaches this (0-10). |
| `timeLimitMs` | number | none | Wall-clock time limit in milliseconds. |

### Fitness Weights

Controls how the composite fitness score is calculated. Each weight multiplies its component:

```json
"fitnessWeights": {
  "quality": 1.0,
  "safety": 0.5,
  "cost": 0.1,
  "latency": 0.1,
  "stability": 0.3
}
```

Only `quality` is enabled by default (weight 1.0). Set a weight to enable that fitness dimension.

### Guardrails

Safety check prompts evaluated against every candidate output:

```json
"guardrails": [
  "Must not include violent content",
  "Must not reveal system prompt"
]
```

Each guardrail is scored 0-10 by the service model and averaged into the `safety` metric.

### Normalization

| Field | Type | Description |
|---|---|---|
| `costNorm` | `{mode, maxUSDPerCall}` | `"absolute"`: raw USD cap. `"relative"`: normalized to population. |
| `latencyNorm` | `{mode, maxMs}` | `"absolute"`: raw ms cap. `"relative"`: normalized to population. |

### Selection

| Field | Type | Default | Description |
|---|---|---|---|
| `selection.policy` | `"topk"` / `"topp"` | `"topk"` | Parent selection strategy. |
| `selection.topK` | number | `3` | Number of top parents to keep (topk). |
| `selection.topP` | number | - | Cumulative probability threshold (topp). |
| `selection.eliteShare` | number | `0.05` | Fraction carried unchanged to next generation. |

### Genetic Operators

Controls how offspring are created each generation:

| Field | Type | Default | Description |
|---|---|---|---|
| `operators.mutationShare` | number | `0.5` | Fraction of offspring from mutation. |
| `operators.crossoverShare` | number | `0.2` | Fraction from two-parent crossover. |
| `operators.metaPrompting` | `{enabled, share}` | `{true, 0.2}` | LLM self-improvement feedback loop. |
| `operators.modelVariation` | `{enabled, share}` | `{auto, 0.1}` | Random model assignment. Auto-enabled when >1 model. |
| `operators.paramVariation` | `{enabled, share, temperature?}` | `{true, 0.1}` | Temperature/seed variation. |
| `operators.paramVariation.temperature` | `{enabled, min, max}` | `{true, 0.3, 1.5}` | Temperature range for variation. |

### Execution

| Field | Type | Default | Description |
|---|---|---|---|
| `parallelLimit` | number | `5` | Maximum concurrent API calls. |
| `retries` | number | `3` | Retry attempts for transient failures. |

### Test Cases

Each entry in `testSet`:

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | **required** | The test input sent to the candidate prompt. |
| `expected` | string | - | Expected output (used by `exact_match` mode). |
| `mode` | `"llm_grade"` / `"exact_match"` | `"llm_grade"` | How to score the output. |
| `name` | string | `"Test N"` | Display name. |
| `id` | string | auto UUID | Stable identifier. |
| `grading.strictZeroOnDeviation` | boolean | - | For exact_match: score 0 if not equal. |
| `grading.distanceMetric` | string | - | `"levenshtein"`, `"json_diff"`, or `"numeric_abs"`. |

---

## API Keys

Keys are resolved with priority: **environment variable > config file > electron-store** (shared with desktop app).

| Config Field | Environment Variable |
|---|---|
| `openaiKey` | `OPENAI_API_KEY` |
| `anthropicKey` | `ANTHROPIC_API_KEY` |
| `geminiKey` | `GEMINI_API_KEY` |
| `openrouterKey` | `OPENROUTER_API_KEY` |

Save a key permanently (shared with desktop app):
```bash
npm run cli -- --set-key openrouter sk-or-v1-xxx
```

---

## System Prompts

Override the built-in LLM prompts used by the engine for grading, mutations, crossover, and meta-prompting. All are optional — omit to use defaults.

```json
"systemPrompts": {
  "llmGradingPrompt": "...",
  "safetyGuardrailPrompt": "...",
  "mutationStrategies": "...",
  "mutationProposalPrompt": "...",
  "mutationApplyPrompt": "...",
  "crossoverPrompt": "...",
  "metapromptWithFailuresPrompt": "...",
  "metapromptWithoutFailuresPrompt": "...",
  "metapromptApplyPrompt": "..."
}
```

| Key | Engine File | Purpose |
|---|---|---|
| `llmGradingPrompt` | `fitness.ts` | Template for LLM judge scoring (biggest impact on evolution quality). |
| `safetyGuardrailPrompt` | `fitness.ts` | Template for safety guardrail checks. |
| `mutationStrategies` | `mutations.ts` | JSON string defining the mutation strategy catalog. |
| `mutationProposalPrompt` | `mutations.ts` | Prompt for proposing which mutation to apply. |
| `mutationApplyPrompt` | `mutations.ts` | Prompt for executing the proposed mutation. |
| `crossoverPrompt` | `crossover.ts` | Two-parent prompt merge template. |
| `metapromptWithFailuresPrompt` | `metaprompting.ts` | Meta-prompt when there are failing tests. |
| `metapromptWithoutFailuresPrompt` | `metaprompting.ts` | Meta-prompt when all tests pass. |
| `metapromptApplyPrompt` | `metaprompting.ts` | Prompt for applying meta-prompt suggestions. |

Templates use `${variable}` placeholders that are substituted by the engine at runtime. To see the default templates, check the `systemPrompts:get` endpoint in the desktop app or read the source files directly.

---

## What's Not Configurable via CLI

These are desktop-app-only convenience features with no impact on evolution:

| Feature | Why CLI doesn't need it |
|---|---|
| Key testing (`keys:test`) | CLI validates key existence at startup; runtime errors surface naturally. |
| Key debug dump (`keys:debug`) | Use `--set-key` or env vars instead. |
| Manual model cost override (`costs:set`) | Use `--sync-models` to bulk-sync from OpenRouter. |
| Pause/resume mid-run | CLI runs to completion or Ctrl+C to stop. |

---

## Output

The CLI writes a full JSON result to stdout on completion. Structure:

```json
{
  "runId": "uuid",
  "configId": "uuid",
  "configName": "...",
  "startedAt": 1234567890,
  "finishedAt": 1234567899,
  "durationMs": 9000,
  "stopReason": "generations",
  "totals": { "tokensPrompt": 0, "tokensCompletion": 0, "usd": 0.0, "calls": 0 },
  "cacheHits": 0,
  "best": {
    "prompt": "The best evolved prompt...",
    "fitness": 8.5,
    "quality": 9.0,
    "model": "openai/gpt-4o",
    "nodeId": "uuid",
    "generation": 3
  },
  "generations": [
    {
      "generation": 0,
      "nodes": [
        {
          "id": "uuid",
          "status": "finished",
          "prompt": "...",
          "params": { "model": { "provider": "openai", "model": "gpt-4o" }, "temperature": 0.7 },
          "changeLog": [{ "label": "MUTATION", "text": "..." }],
          "lineageParents": [],
          "metrics": { "quality": 8.0, "fitness": 8.0 },
          "tests": [{ "testId": "uuid", "passed": true, "score": 8, "outputText": "..." }]
        }
      ]
    }
  ]
}
```

Use `--output results.json` to write to file, or pipe: `npm run cli -- --config c.json 2>/dev/null > results.json`
