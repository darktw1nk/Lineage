# PromptEngine.AI

**Evolve LLM prompts with a genetic algorithm — measurable quality instead of vibes.**

You give it a seed prompt and a test set. It breeds a population of prompt variants across generations — mutating, crossing over, meta-prompting from test failures — evaluates every candidate against your tests across multiple LLM providers, and selects for fitness: a weighted blend of quality, safety, cost, latency, and stability.

![Evolution run](docs/assets/evolution-run.gif)

*A real run: 30 candidates across 3 generations, 6 models competing, 47 seconds, $0.013. The seed prompt scored 5.30; the evolved winner scored 9.73 — found by crossover, running on a model 25× cheaper than the flagship.*

## Two ways to use it

| | For | Interface |
|---|---|---|
| **Desktop app** | Humans | Electron app with a live React Flow lineage graph |
| **`promptengine` CLI** | Agents, CI, scripts | JSON config in → JSON results out, exit codes, budget caps |

Both share the same engine (`@promptengine/core`). An AI agent gets a better prompt with three commands; a human watches the population evolve in real time.

## Quick start — CLI (agents, CI)

```bash
git clone <this repo> && cd evolution2 && npm install

# 1. Discover catalogued models + pricing
npm run cli -- --list-models --db ./run.db

# 2. Write a config
cat > evolve.json << 'EOF'
{
  "name": "Ticket triage",
  "seedPrompt": "Summarize the support ticket.",
  "models": ["gemini/gemini-2.5-flash-lite"],
  "serviceModel": "gemini/gemini-2.5-flash-lite",
  "populationSize": 4, "generationSize": 4, "maxGenerations": 2,
  "budget": 0.02,
  "testSet": [
    { "name": "refund", "mode": "llm_grade",
      "prompt": "<realistic ticket text>", "expected": "<reference answer>" }
  ]
}
EOF

# 3. Evolve (keys via env: GEMINI_API_KEY, OPENAI_API_KEY, ...)
npm run cli -- --config evolve.json --db ./run.db --output results.json
```

`results.json` contains the best prompt, per-node test scores with judge reasoning, full lineage, and cost totals. Exit code 0 means a usable best prompt exists. Typical cost for a small run: **under a cent**. Full config reference: [docs/cli.md](docs/cli.md).

Installable packages (`@promptengine/core` + `@promptengine/cli`, `npx promptengine`) build from `packages/` — not yet published to npm.

**Using Claude Code?** The repo ships an [`evolving-prompts` skill](.claude/skills/evolving-prompts/SKILL.md) that teaches agents the whole workflow — it was validated by A/B testing agents with and without it.

## Quick start — Desktop (humans)

```bash
npm run electron:dev      # dev mode
npm run build             # NSIS installer + portable .exe (Windows)
```

Configure everything in the UI — models are loaded from a maintained catalog with live pricing:

![New evaluation](docs/assets/new-evaluation.png)

Watch generations appear with full lineage, then inspect any node — its evolved prompt, changelog (which operator created it and why), per-test scores with judge reasoning, and exact cost:

![Evolution graph](docs/assets/evolution-graph.png)

![Node details](docs/assets/node-details.png)

## How the evolution works

Each generation:

1. **Evaluate** — every candidate prompt runs the full test set (`exact_match` with distance metrics, or `llm_grade` with an LLM judge that sees your `expected` reference). Runs are parallel with a global concurrency cap and per-call cost tracking.
2. **Score** — fitness = weighted blend of quality, safety, cost, latency, stability.
3. **Select** — Top-K or Top-P, with elitism (the champion survives unchanged).
4. **Breed** — operators create the next generation:
   - **Mutation** — strategy-guided rewrites (structure, compression, constraints, removal…)
   - **Crossover** — merges two strong parents
   - **Meta-prompting** — reads actual test failures and makes surgical fixes (the only failure-aware operator)
   - **Param variation** — temperature/seed changes
   - **Model variation** — same prompt, different model; evolution can discover that switching models beats rewording
5. **Stop** — on max generations, budget cap, target fitness, or time limit.

**Providers**: OpenAI, Anthropic, Google Gemini, Groq directly, or any model via OpenRouter (one key, synced catalog with pricing).

## Repository layout

```
packages/core     @promptengine/core — engine, operators, providers, sql.js persistence
packages/cli      @promptengine/cli  — the promptengine command
apps/desktop      Electron app (React + React Flow)
docs/cli.md       Full CLI + config reference
```

Architecture details in [CLAUDE.md](CLAUDE.md). Tests: `npm test` (298 tests across all packages).

## License

[MIT](LICENSE)
