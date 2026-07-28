# Tool-Call + Structured-Output Evaluation

**Date**: 2026-07-29
**Status**: Approved design, pending implementation plan

## Goal

Two new test modes make PromptEngine evaluate the dominant agent-builder prompt genres: `json_schema` ("output conforms to this response schema") and `tool_call` ("calls the right function with the right arguments"). Both score deterministically — no judge calls, no judge noise, zero grading cost — giving evolution a crisp gradient.

## Types (`packages/core/src/types.ts`)

- `TestCase.mode` union grows: `'llm_grade' | 'exact_match' | 'json_schema' | 'tool_call'`.
- `TestCase` gains:
  - `schema?: object;` — JSON Schema for `json_schema` mode.
  - `tools?: ToolDef[];` — tool definitions for `tool_call` mode.
  - `expectedTool?: { name: string; args?: Record<string, unknown>; argsMode?: 'subset' | 'exact' };` — `argsMode` default `'subset'`.
- New `export interface ToolDef { name: string; description?: string; parameters?: object; }` (OpenAI function shape = the canonical format).
- `ProviderAdapter.call` opts gain `tools?: ToolDef[];`; the return type gains `toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;` (same additions on `BaseProviderAdapter.call`/`callAPI`).
- `TestResult` unchanged — tool responses serialize into `outputText` (below), so samples, cache, playoff, report, and UI plumbing all work unchanged.

## Scoring (`packages/core/src/engine/structured.ts`, new module)

- `scoreJsonSchema(output: string, schema: object): { passed: boolean; score: number; detail: string }`
  - Strip markdown fences (same regex family as the judge parsers), `JSON.parse`.
  - Unparseable → score 0, detail `'invalid JSON: <err>'`.
  - Parses but violates schema → `score = Math.max(1, 6 - errorCount)` (1..5 — climbing gradient as violations drop), detail lists the first ajv errors.
  - Fully conformant → 10. `passed = score >= 7` (only conformance passes).
  - Validation via **ajv** (new core dependency, `new Ajv({ strict: false, allErrors: true })`); compiled validators cached per test id (schemas are static per run). An invalid schema itself → score 0 with detail `'schema error: …'` (never throws into the engine).
- `scoreToolCall(toolCalls: Array<{name, arguments}> | undefined, expected: TestCase['expectedTool']): { passed: boolean; score: number; detail: string }`
  - No `expectedTool` on the test → configuration error → score 0, detail says so.
  - No tool called → 0 (`detail: 'no tool call (plain text response)'`).
  - First call judged (multi-call sequences out of scope). Wrong name → 2. Right name, args mismatch → 6 (detail shows expected-vs-actual args diff). Right name + args → 10; `passed = score >= 7`.
  - `subset` (default): every key in `expected.args` deep-equals the actual argument value; extra actual keys are fine. `exact`: deep equality of the whole args object. No `expected.args` at all → name match alone scores 10.
- `detail` lands in `TestResult.llmGradeReasoning` (existing display channel — Node Details and reports already render it) so users see WHY a tool test scored 6.

## Engine (`evaluator_v2.ts` `runSingleSample` + grading block)

- Candidate call passes `tools: test.tools` when `test.mode === 'tool_call'`.
- Effective output for storage: if the response has `toolCalls`, `outputText = JSON.stringify({ toolCalls }, null, 2)`; otherwise the text output as today. (Cache key unchanged — tools live on the test, and the fitness-test signature is already part of the key.)
- Grading dispatch: `json_schema` and `tool_call` route to the new sync scorers (in the existing non-llm_grade branch); `llm_grade`/`exact_match` untouched. The scorer's `detail` is stored like judge reasoning.
- Empty text output is NOT an error when `toolCalls` are present.
- Meta-prompting failure summaries work as-is (they read outputText + scores; the serialized tool call plus the detail string IS the failure signal).

## Providers (all five adapters)

Canonical `ToolDef` → provider translation, and response → canonical `toolCalls`:

- **OpenAI / Groq / OpenRouter** (shared shape): request `body.tools = tools.map(t => ({ type: 'function', function: t }))`, `body.tool_choice = 'auto'`; response `choices[0].message.tool_calls[]` → `{ name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') }` (parse failures → `{}` + warn). `message.content` may be null → output `''`.
- **Gemini**: request `body.tools = [{ functionDeclarations: tools.map(({name, description, parameters}) => ({ name, description, parameters })) }]`; response `candidates[0].content.parts[]` with `functionCall` → `{ name: p.functionCall.name, arguments: p.functionCall.args ?? {} }`; text parts still concatenate into output.
- **Anthropic**: request `body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters ?? { type: 'object' } }))`; response `content[]` blocks of `type: 'tool_use'` → `{ name: b.name, arguments: b.input ?? {} }`; text blocks concatenate into output.
- Adapters return `toolCalls` ONLY when the response actually contains calls (absent otherwise — keeps non-tool paths byte-identical). Empty-output guards in adapters must not throw when toolCalls are present.

## Desktop UI (first-class, not an afterthought)

- **TestSetTab** (`NewEvaluationModal.tsx`): the per-test mode select gains `JSON Schema` and `Tool Call` options. Conditional editors below the prompt field:
  - `json_schema`: "Response Schema (JSON)" textarea — parsed on blur; red border + inline message on invalid JSON; stored as object.
  - `tool_call`: "Tools (JSON array)" textarea (same validation) + "Expected Tool" row: name text input, args JSON textarea (optional), argsMode select (`subset`/`exact`).
  - Invalid JSON in any editor blocks Start with a clear toast (same pattern as existing validation).
- **RightPanel (Node Details)**: when a test result's outputText parses as `{ toolCalls: [...] }`, render a readable line instead of raw JSON: `→ get_weather({"city":"Paris"})` plus the scorer `detail` beneath (already rendered via the reasoning channel). Plain-text fallback otherwise.
- Config import/export already round-trips testSet JSON — new fields ride along untouched.

## CLI (`packages/cli/src/config.ts`)

- `CliConfig.testSet` entries gain `schema?: object; tools?: ToolDef[]; expectedTool?: {...}` (same shapes); mode union extended. `toEvaluationConfig`'s explicit testSet mapping passes the three fields through (it whitelists — silent dropping is the failure mode to avoid).
- `docs/cli.md`: new "Agent-builder test modes" section with one full example of each mode, the scoring ladders (0/2/6/10 and 0/1..5/10), and the argsMode semantics.
- `evolving-prompts` skill: bullet for when to use each mode + the fact they're judge-free (cheap, deterministic).
- README: dials/feature surface — this is ad-worthy ("evolve prompts that call the right function").

## Out of scope

Multi-step tool sequences / conversations; parallel tool-call scoring beyond the first call; executing tools; forced tool_choice per test; streaming; schema-constrained decoding (`response_format`) — the point is testing whether the PROMPT elicits conformance.

## Testing

- **structured.ts unit**: json_schema — valid → 10; fenced JSON accepted; unparseable → 0; violation count gradient (missing 1 required vs 3 → higher/lower); invalid schema → 0 not throw. tool_call — no call → 0; wrong tool → 2; right tool wrong args → 6; subset match with extra keys → 10; exact mode rejects extra keys; no expected.args → name alone = 10; nested arg deep-equality.
- **Adapter translation** (fetch-stub style, per provider): request body carries correctly translated tools; canned tool-call responses parse to canonical `toolCalls`; arguments JSON-string parsing (OpenAI) and object passthrough (Gemini/Anthropic); text+tool mixed responses yield both output and toolCalls.
- **E2E** (fidelity harness, fake adapter returning scripted toolCalls): a run with tool_call + json_schema tests scores deterministically, outputText carries serialized calls, detail lands in reasoning, samplesPerTest averages, evolution completes.
- **CLI**: config passthrough test for the three new fields + mode.
- **Live**: (1) flash-lite tool-routing evolution — 3 tool_call tests (weather/time routing with args), vague seed prompt, verify scores improve and results show real functionCall parsing; (2) json_schema extraction run reaching 10s on conformance. Desktop CDP smoke: mode options present, schema editor validates, Node Details renders the `→ tool(args)` line for a tool run.
- Definition of done: full suite + type-check green; both live runs verified; UI smoke passes.
