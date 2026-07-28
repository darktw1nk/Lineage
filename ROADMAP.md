# PromptEngine.AI — Roadmap

## Status at a glance

| Phase | Status |
|---|---|
| 1. Test suite (contract-driven) | ✅ Done — 320 tests across core, cli, desktop |
| 2. OpenRouter integration | ✅ Done — adapter, model sync, pricing, settings UI |
| 3. CLI / script mode + agent skill | ✅ Done — `promptengine` bin, JSON contract, `evolving-prompts` skill |
| 3.5. Packaging split (unplanned) | ✅ Done — npm-workspaces monorepo: `packages/core` + `packages/cli` + `apps/desktop` |
| 4. README + demo | ✅ Done — concept-first README, live UI GIF + screenshots, install guide, LICENSE, CONTRIBUTING |
| 5. Plugin system | ✅ Done — registry + loader in core, built-ins as entries, both hosts, Settings panel, examples |
| 6. Publish | ⬜ Open decisions — the active phase |

Historical phase details live in git history; what follows is only what's ahead.

---

## Phase 5: Plugin system — shipped 2026-07-28

Registry + file-based loader in `@promptengine/core`; the five built-in operators are registry entries behind the same `OperatorPlugin` interface as plugins. Both hosts load plugins (CLI: config `plugins` field / `--plugins`; desktop: `userData/plugins` with a Settings panel). Author guide: `docs/plugins.md`; working examples in `examples/plugins/` (section-shuffle operator, Ollama provider).

Deliberately out of scope, candidates for later: npm-package plugin discovery, per-plugin config UI/schemas, hot reload, in-app install, plugin-contributed fitness dimensions/selection policies/grading modes.

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
