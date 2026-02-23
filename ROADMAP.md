# PromptEngine.AI — Open Source Roadmap

## Phase 1: Test Suite (Contract-Driven)

**Goal**: Full test coverage — unit and integration — written from contracts, not implementation. Test authors should work from interfaces and expected behavior only, then we verify the implementation passes and fix where needed.

**Approach**:
- Set up Vitest (Vite-native, fast, TypeScript-first)
- Tests are written against contracts/interfaces, not by reading implementation code
- The test-writing agent receives only type definitions, function signatures, and behavioral specs — never the implementation source
- After tests are written, run them against the actual code and fix failures (bugs in implementation, not in tests)

### Unit Tests

#### Engine (`electron/engine/`)
- **fitness.ts** — Weighted composite calculation, edge cases (zero weights, all-zero scores, normalization modes: absolute vs relative for cost/latency)
- **generation.ts** — Top-K/Top-P selection, elitism preservation, parent weighting distribution, population size maintenance, operator share normalization
- **mutations.ts** — Strategy catalog selection, prompt transformation structure, changelog generation
- **crossover.ts** — Two-parent merge, output structure, parent attribution
- **metaprompting.ts** — Feedback loop structure, improvement application
- **paramvariation.ts** — Temperature bounds (0..2), seed generation
- **modelvariation.ts** — Random model selection from allowed set, provider consistency
- **semaphore.ts** — Concurrency limiting, acquire/release correctness, queue ordering
- **operators_v2.ts** — Shell population creation, initial node structure

#### Providers (`electron/providers/`)
- **base.ts** — Cost calculation (tokens x pricing), API key retrieval flow, retry integration
- **costs.ts** — Model cost lookup, default fallback, cost storage/retrieval
- **retry.ts** — Retry count, backoff behavior, transient vs permanent error classification
- **rateLimiter.ts** — RPM/TPM enforcement, sliding window, multi-provider isolation
- **openai.ts / anthropic.ts / gemini.ts** — Request formatting, response parsing, token extraction (mock API responses)

#### Database (`electron/database/`)
- **init.ts** — Schema creation, migration idempotency, table structure verification

#### Frontend utilities (`src/utils/`)
- **distance.ts** — Levenshtein, JSON diff, numeric distance — deterministic, easy to test
- **cn.ts** — Class merging behavior

#### Store (`src/store/`)
- **evaluationStore.ts** — Mutation correctness (setEvaluation, updateNodeInEvaluation, updateStatus), subscription lifecycle

### Integration Tests

- **Evaluation lifecycle** — Create config → start run → process queue → calculate fitness → advance generation → stop on condition
- **IPC round-trip** — Handler registration, message passing, subscription/unsubscription (mocked Electron)
- **Provider → Engine** — Mock API responses flowing through provider adapter → fitness calculation → selection
- **Database CRUD** — Full cycle: create evaluation config, save run, query nodes, export/import JSON
- **Cost tracking** — API calls accumulate correctly in totals and cost ledger

---

## Phase 2: OpenRouter Integration

**Goal**: Replace fixed per-provider API keys and hardcoded model lists with a single OpenRouter key. Dynamic model discovery and pricing from OpenRouter's API.

### Changes

#### Backend
- Add OpenRouter provider adapter (`electron/providers/openrouter.ts`)
  - Single API key (stored via keytar, same pattern)
  - Route requests through OpenRouter's unified endpoint
  - Map OpenRouter model IDs to internal ModelRef format
- Add model discovery endpoint
  - Fetch available models from OpenRouter API (`/api/v1/models`)
  - Cache model list locally (refresh on demand)
  - Pull pricing per model from OpenRouter (input/output token costs)
- Keep existing direct providers as fallback option (user choice: OpenRouter vs direct keys)

#### Frontend
- Rewrite `SettingsModal.tsx` — single OpenRouter API key field instead of per-provider key inputs, with toggle for "direct provider keys" mode
- Rewrite model selection in `NewEvaluationModal.tsx`
  - Dynamic model dropdown populated from OpenRouter's model list
  - Search/filter by provider, capability, price
  - Show pricing inline (cost per 1M tokens)
  - Auto-fill model costs from OpenRouter data (no manual cost entry)
- Update `EvaluationConfigPanel.tsx` to show OpenRouter model names

#### Migration
- Existing evaluations with direct provider keys continue to work
- New evaluations default to OpenRouter if key is configured

---

## Phase 3: CLI / Script Mode

**Goal**: Run prompt evolution from command line without Electron UI. Enable use as a Claude Code skill so the AI can configure and launch evolution runs programmatically.

### Design

#### CLI Entry Point
- New entry: `cli/index.ts` — standalone Node.js script (no Electron dependency)
- Reuses engine, providers, database, fitness modules directly
- Config via:
  - JSON config file (`--config evolution.json`)
  - Command-line flags for common options
  - Interactive prompts for missing required fields

#### Config File Format
```json
{
  "name": "Optimize customer support prompt",
  "systemPrompt": "You are a helpful customer support agent...",
  "testSet": [
    { "prompt": "How do I reset my password?", "mode": "llm_grade" },
    { "prompt": "What is 2+2?", "mode": "exact_match", "expected": "4" }
  ],
  "models": ["openai/gpt-4o", "anthropic/claude-3.5-sonnet"],
  "populationSize": 8,
  "maxGenerations": 5,
  "fitnessWeights": { "quality": 0.7, "cost": 0.2, "latency": 0.1 },
  "budget": { "maxSpend": 5.00 },
  "openrouterKey": "sk-or-..."
}
```

#### Output
- Progress to stdout (generation number, best fitness, cost so far)
- Final results as JSON to stdout or `--output results.json`
- Best prompt printed clearly at the end
- Exit code 0 on success, 1 on failure/budget exceeded

#### Claude Code Skill
- Create a skill definition that wraps the CLI
- Claude can: analyze user's prompt, generate test cases, configure fitness weights, run evolution, report results
- The skill bridges the gap between "I want a better prompt" and the many configuration variables

### Implementation Notes
- Extract shared engine code so both Electron and CLI can use it without duplication
- Database is optional in CLI mode (can run stateless, output JSON only)
- OpenRouter integration from Phase 2 makes CLI simpler (one key, any model)

---

## Phase 4: README + Demo

**Goal**: Proper open source README with demo GIF showing the evolution graph in action.

### README Contents
- One-line description + screenshot/GIF at top
- What it does (the "evolution" concept explained simply)
- Quick start (install, configure API key, run first evolution)
- CLI usage examples
- Architecture overview (link to CLAUDE.md for details)
- Contributing guide
- License

### Demo
- Screen recording of a real evolution run: create evaluation, watch nodes appear, fitness improve, best prompt selected
- Convert to GIF, keep under 10MB
- Show the React Flow graph populating in real time — that's the visual hook

---

## Phase 5: Plugin System for Operators and Providers

**Goal**: Make operators and providers formally pluggable so community contributors can add new ones without modifying core code.

### Operator Plugin Interface
- Define `OperatorPlugin` interface: `name`, `apply(parents, config) => CandidateNode[]`
- Operators register themselves (file-based discovery or explicit registration)
- Built-in operators (mutation, crossover, meta, param, model) become plugins
- Community examples: chain-of-thought injection, few-shot example evolution, prompt compression

### Provider Plugin Interface
- Define `ProviderPlugin` interface extending current `ProviderAdapter`
- File-based plugin loading from a `plugins/` directory
- Community examples: Ollama (local models), Mistral, Cohere, AWS Bedrock, Azure OpenAI

### UI Support
- Operator weights in NewEvaluationModal dynamically reflect available plugins
- Provider dropdown includes plugin-provided providers
- Plugin management panel in Settings (enable/disable, configure)

---

## Execution Order

```
Phase 1 (Tests)  →  Phase 2 (OpenRouter)  →  Phase 3 (CLI)  →  Phase 4 (README)  →  Phase 5 (Plugins)
     ↑                                            ↑
     |                                            |
  Foundation — nothing ships                Phase 2 makes this
  without tests                             much simpler (one key)
```

Phase 1 is the foundation. Every subsequent phase gets tested as it's built. Phase 2 unblocks Phase 3 (CLI with one key is way simpler than managing multiple provider keys from command line). Phase 4 and 5 are polish and extensibility — do them once the core product is solid.
