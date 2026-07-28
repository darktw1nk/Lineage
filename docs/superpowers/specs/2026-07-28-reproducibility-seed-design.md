# Run-Level Reproducibility (`seed` / `--seed`)

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

All engine-level randomness (operator plan, parent assignment, mutation strategy selection, temperature sampling, model hops) becomes bit-reproducible under a run-level seed, and candidate LLM calls receive derived best-effort sampling seeds. `promptengine --config cfg.json --seed 42` twice produces identical evolution decisions. Without a seed, behavior is exactly today's (Math.random).

**Honest contract (goes in docs verbatim):** same seed + same config ⇒ identical operator plans, parent assignments, mutation strategies, temperatures, model hops, holdout splits, and candidate seeds. LLM *outputs* remain best-effort (provider-side sampling; Anthropic has no seed parameter) — the seed reproduces the experimental protocol, not the weather.

## Configuration

- `EvaluationConfig.seed?: number` (integer). Absent → non-deterministic (today's behavior, no code path change).
- CLI: `"seed"` key in config JSON; new `--seed <n>` flag overrides the config value.
- Desktop: "Seed" number input in the Evaluation harness section (Service tab), blank = unset.
- Precedence for the holdout split: explicit `holdoutSeed` > `seed` > current default 42. (Seed controls ALL randomness unless a more specific knob is set.)
- Echo: `EvolutionResult.seed?: number` in results.json; report header gains `**Seed:** 42` when set.

## RNG module (`packages/core/src/engine/rng.ts`, new)

- `mulberry32(seed: number): () => number` moves here from `holdout.ts` (holdout imports it; behavior byte-identical so existing holdout splits are unchanged).
- `rngFor(seed: number | undefined, ...labels: Array<string | number>): () => number` — when `seed` is undefined returns `Math.random`; otherwise FNV-1a-hashes `labels.join('\0')`, mixes with the seed, and returns a fresh mulberry32 stream.
- **Why derived streams, not one shared stream**: initial-fill mutations run in `Promise.all` parallelism (`evaluator_v2.ts:274`) and operator applications interleave on the event loop. A consumed-in-order stream would make results depend on async scheduling. Independent streams keyed by stable labels are scheduling-proof.

## Site wiring (stable labels per decision site)

| Site | Stream label | Change |
|---|---|---|
| Initial population fill (`evaluator_v2.ts` fill loop) | `('fill', nodeIndex)` | pass rng into `mutateNode` |
| Parent-assignment shuffle (`generation.ts` `assignParentsToChildren`) | `('parent-assign', generation)` | rng param from `createNextGeneration` |
| Operator plan shuffle (`generation.ts` step 5) | `('operator-plan', generation)` | local `rngFor` call (config in scope) |
| Per-child operator randomness | `('operator', generation, childIndex)` | engine builds rng, sets `OperatorContext.rng` |
| Mutation strategy count + selection (`mutations.ts`) | via `mutateNode(basePrompt, config, rng = Math.random)` | also replace the biased `sort(() => Math.random()-0.5)` with Fisher–Yates using the rng |
| Temperature sampling (`paramvariation.ts`) | `ctx.rng ?? Math.random` | |
| Model pick (`modelvariation.ts`) | `ctx.rng ?? Math.random` | |
| Candidate provider seed | `('node-seed', generation, childIndex)` → `Math.floor(rng() * 2**31)` | set `params.seed` on newly created nodes (and gen-0 shell nodes) when `config.seed` is set and `params.seed` is unset |

- `OperatorContext` gains `rng?: () => number`. Engine always provides it; plugin operators inherit reproducibility for free (one line in `docs/plugins.md`). Built-in wrappers in `registry.ts` thread it to the underlying functions.
- Elite clones keep their params (never re-evaluated) — no seed rewrite.
- Retry jitter (`retry.ts:59`) stays `Math.random` — affects timing only, never outcomes.
- Node UUIDs stay random — identity only, no evolution decision reads them.

## Provider seed forwarding

- `openai.ts` already sends `body.seed` (except restricted models) — unchanged; verify `groq.ts`/`openrouter.ts` (OpenAI-compatible) forward it too, add if missing.
- `gemini.ts` accepts `opts.seed` but drops it — add `generationConfig.seed`.
- `anthropic.ts` — API has no seed parameter; documented as N/A.

## Out of scope

Bit-identical LLM outputs; seeding node UUIDs; seeding retry jitter; cache-key changes; deterministic wall-clock/latency/cost metrics.

## Testing

- **rng unit**: same seed + labels ⇒ identical sequence; different labels ⇒ different streams; undefined seed ⇒ `Math.random` passthrough; mulberry32 relocation keeps `partitionTestSet` outputs identical (existing holdout tests must stay green untouched).
- **generation**: with seed, two `createNextGeneration` calls (mocked operators) produce identical operator plans and parent assignments; different seed ⇒ different plan (probabilistically; assert on a case verified to differ).
- **mutations**: `selectRandomStrategies(n, rng)` deterministic under seeded rng; Fisher–Yates replaces biased sort.
- **E2E** (fidelity-style, deterministic fake adapter): two runs same config + seed ⇒ identical lineage (changelogs, temperatures, model params, prompts, candidate `params.seed` values); unseeded run works as today. Holdout precedence: `holdoutSeed` wins over `seed`.
- **CLI**: `--seed 42` overrides config `"seed"`; passthrough test in config tests; results.json contains `seed`.
- **Live**: two real flash-lite runs `--seed 42` — diff decision sequences (operator labels per child, temperatures, node seeds) for equality; one run with a different seed differs.
- Definition of done: full suite + type-check green; live double-run diff clean.
