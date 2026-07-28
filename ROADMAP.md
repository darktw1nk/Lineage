# PromptEngine.AI — Roadmap

## Status at a glance

| Phase | Status |
|---|---|
| 1. Test suite (contract-driven) | ✅ Done — 320 tests across core, cli, desktop |
| 2. OpenRouter integration | ✅ Done — adapter, model sync, pricing, settings UI |
| 3. CLI / script mode + agent skill | ✅ Done — `promptengine` bin, JSON contract, `evolving-prompts` skill |
| 3.5. Packaging split (unplanned) | ✅ Done — npm-workspaces monorepo: `packages/core` + `packages/cli` + `apps/desktop` |
| 4. README + demo | ✅ Done — concept-first README, live UI GIF + screenshots, install guide, LICENSE, CONTRIBUTING |
| 5. Plugin system | ⬜ Not started — the active phase |
| 6. Publish | ⬜ Open decisions |

Historical phase details live in git history; what follows is only what's ahead.

---

## Phase 5: Plugin system for operators and providers

**Goal**: community contributors add operators and providers without touching core.

### Operator plugins
- `OperatorPlugin` interface: `name`, `apply(parents, config) => CandidateNode[]`
- Registration: file-based discovery from a `plugins/` directory + explicit registration API
- Built-in operators (mutation, crossover, meta, param, model) become plugins themselves
- Candidate ideas: chain-of-thought injection, few-shot example evolution, prompt compression

### Provider plugins
- `ProviderPlugin` interface extending the current `ProviderAdapter`
- Same file-based loading; keys resolved through the existing store seam
- Candidate ideas: Ollama (local models), Mistral, Cohere, AWS Bedrock, Azure OpenAI

### UI support
- Operator weights in NewEvaluationModal reflect registered plugins dynamically
- Provider dropdown includes plugin providers
- Plugin management panel in Settings (enable/disable, configure)

### Constraints learned since the original plan
- Plugins must work in BOTH hosts (Electron main process and plain-Node CLI) — loading goes through core with host-provided paths, not Electron APIs
- `@promptengine/core`'s public index stays the only contract; plugin interfaces get exported there

---

## Phase 6: Publish

Open decisions, in order:

1. **npm scope/name** — `@promptengine/*` is a placeholder; check availability and claim before first publish
2. **GitHub remote** — repo has no remote today; README assets and installer distribution (GitHub Releases) need one
3. First `npm publish` of `@promptengine/core` + `@promptengine/cli` (both are pack-verified)
4. Desktop installers attached to GitHub Releases

---

## Backlog (unscheduled)

- Judge-fence hardening: LLM judge returns fenced JSON; parsing handles it but a response-format constraint would be cleaner
- CLI `--report <path>` flag for explicit report placement
- Cost ledger surfacing in the CLI results JSON
- macOS/Linux desktop builds (engine and CLI are already platform-neutral)
