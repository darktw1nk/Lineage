# Contributing to PromptEngine.AI

Thanks for your interest! This document covers what you need to work on the codebase.

## Setup

```bash
git clone <this repo>
cd evolution2
npm install          # one install for all workspaces
npm test             # verify: all suites green
npm run type-check   # verify: strict TS clean across core, cli, desktop
```

Node.js ≥ 20 required. No native modules — the database is sql.js (WebAssembly), so no compiler toolchain is needed on any platform.

## Where things live

```
packages/core     @promptengine/core — GA engine, operators, providers, persistence
packages/cli      @promptengine/cli  — the promptengine command
apps/desktop      Electron app (React 18 + React Flow + Zustand + Tailwind/shadcn)
docs/             install guide, CLI reference
.claude/skills/   agent skill for driving the CLI
```

Architecture notes: [CLAUDE.md](CLAUDE.md). Key boundary rule: **`packages/core` must never depend on Electron** — hosts inject platform services (`setStore`, `setSendUpdate`, `initializeDatabase(dbPath)`).

## Development loop

```bash
npm run electron:dev                                  # desktop app with HMR
npm run cli -- --config <cfg> --db ./dev.db           # CLI from source (tsx)
npm run test:watch                                    # vitest watch mode
npx vitest run packages/core/tests/engine/fitness.test.ts   # single file
```

## Rules of the road

- **Tests accompany changes.** Engine/provider/CLI changes need unit tests in the matching `tests/` dir; bug fixes need a regression test that fails without the fix. The suite must stay green: `npm test`.
- **Strict TypeScript stays strict** (`noUnusedLocals`, `noUnusedParameters` included). `npm run type-check` must pass.
- **Migrations are append-only.** Never edit an applied migration in `packages/core/src/database/init.ts` — add the next `version === N` block, collapse `schema_version` via the existing `setVersion` helper, and add a migration test (see `packages/core/tests/database/init-path.test.ts` for the pattern, including the legacy multi-row case).
- **Never log secrets.** API keys and store contents must not reach console output — log presence/absence, not values.
- **Model catalog changes** (`insertDefaultModelCosts`) require a schema-version bump + migration and verified pricing (OpenRouter's public API is a good source); for Gemini, confirm the model actually serves `generateContent` — being listed is not enough.
- **ESM everywhere**; relative imports keep the `.js` extension. Consumers import from `@promptengine/core`'s index only — deep imports are not part of the contract.
- Commit messages: plain, imperative, no attribution trailers.

## Testing patterns already in the repo

- Provider adapters: `vi.stubGlobal('fetch', mockFetch)` — see `packages/core/tests/providers/adapters.test.ts`
- Engine operators: mock the provider factory — `vi.mock('../../src/providers/index.js')`
- CLI: mock the whole engine — `vi.mock('@promptengine/core')` — see `packages/cli/tests/engine.test.ts`
- IPC handlers: real sql.js db + mocked Electron — see `apps/desktop/tests/ipc/handlers.test.ts`
- Renderer store: plain Zustand state assertions — see `apps/desktop/tests/store/evaluationStore.test.ts`

## Good first contributions

The active roadmap item is the **plugin system** ([ROADMAP.md](ROADMAP.md) Phase 5): operator and provider plugin interfaces with file-based discovery. Smaller ideas: new mutation strategies for the catalog in `packages/core/src/engine/mutations.ts`, additional distance metrics in `packages/core/src/utils/distance.ts`, or provider adapters (Ollama, Mistral, Bedrock) following the pattern in `packages/core/src/providers/`.
