# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PromptEngine.AI** — evolves LLM prompts using genetic algorithms. Users configure a test set with fitness metrics (quality, safety, cost, latency, stability); candidate prompts are evaluated in parallel across multiple LLM providers (OpenAI, Anthropic, Google Gemini, OpenRouter, Groq). Two front doors share one engine: a CLI for scripts/CI/AI agents and an Electron desktop app that visualizes evolution as a generation lineage graph.

**Stack**: Electron 28 + React 18 + TypeScript 5 + Vite 5 + Zustand + TanStack React Query + Tailwind CSS + React Flow + shadcn/ui
**Engine**: Node.js with SQLite (sql.js — WebAssembly, no native modules); host-injected key/value store (electron-store in the desktop app)

## Workspace Layout (npm workspaces)

```
packages/core     @promptengine/core — engine, providers, database, types (publishable)
packages/cli      @promptengine/cli  — command-line runner, bin: "promptengine" (publishable)
apps/desktop      evolution2         — private Electron app (React renderer + IPC shell)
```

- `@promptengine/core` has zero Electron dependencies. Hosts inject platform services before use: `setStore(...)`, `setSendUpdate(...)`, `initializeDatabase(dbPath)` (path is required).
- Consumers import ONLY from the core index (`@promptengine/core`); deep imports are not part of the contract.
- In dev, `@promptengine/core` resolves to core *source* via tsconfig `paths` / vite aliases; published consumers get `dist/` via the package `exports` map. The desktop main-process bundle inlines core source (only `sql.js` stays external).
- The desktop package name MUST stay `evolution2` — the dev userData path (`%APPDATA%\evolution2\evolution.db`) and the CLI's shared-database discovery depend on it.

## Commands (run from repo root)

```bash
npm run electron:dev     # Full dev mode (Vite HMR + Electron, port 5173)
npm run dev              # Vite dev server only (no Electron)
npm run cli -- --help    # CLI from source (tsx)
npm run type-check       # tsc across all three workspaces
npm run build:packages   # tsup builds of core + cli (dist/)
npm run build            # Desktop: vite build + electron-builder installers
npm run build:strict     # type-check + desktop build
npm test                 # All test projects (vitest workspace)
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage
```

Run a single test file: `npx vitest run packages/core/tests/engine/fitness.test.ts`.
Tests live in `packages/core/tests/`, `packages/cli/tests/`, and `apps/desktop/tests/`.

## Architecture

### Process Model (Electron IPC)

```
Renderer (React)  <--IPC-->  Main Process (Node.js)
   Zustand store               @promptengine/core engine
   React Flow graph            IPC handlers + logger
   shadcn/ui components        electron-store (injected via setStore)
```

- **Renderer → Main**: `window.electronAPI.*` via context bridge (`apps/desktop/electron/preload.ts`)
- **Main → Renderer**: event streaming via `webContents.send()`, wired with `setSendUpdate()` in `apps/desktop/electron/main.ts`
- Context isolation enabled; no nodeIntegration. All network calls happen in the main process / CLI process only.

### Engine — `packages/core/src/`

- **Orchestrator**: `engine/evaluator_v2.ts` — evaluation loop: queue processing, test execution, fitness calculation, generation advancement
- **Generation logic**: `engine/generation.ts` — Top-K/Top-P selection, elitism, parent weighting, child distribution
- **Operators**: `engine/mutations.ts`, `engine/crossover.ts`, `engine/metaprompting.ts`, `engine/paramvariation.ts`, `engine/modelvariation.ts`
- **Fitness**: `engine/fitness.ts` — weighted composite of quality, safety, cost, latency, stability
- **Concurrency**: `engine/semaphore.ts` — global parallel limit
- **Providers**: `providers/` — adapter pattern; `base.ts` + `openai.ts`, `anthropic.ts`, `gemini.ts`, `openrouter.ts`, `groq.ts`; factory in `providers/index.ts`; retry in `retry.ts`, cost lookup in `costs.ts`
- **Persistence**: `database/init.ts` — `SqlJsWrapper` (better-sqlite3-compatible API over sql.js WASM). Tables: `evaluation_configs`, `evaluation_runs`, `candidate_nodes`, `model_costs`, `app_settings`, `cost_ledger`
- **Public API**: `index.ts` — everything consumers may import

### CLI — `packages/cli/src/`

`index.ts` (arg parsing, commands), `config.ts` (JSON config → EvaluationConfig), `store.ts` (env > config > stored keys), `engine.ts` (run orchestration + result collection), `display.ts` (stderr progress), `report.ts`, `database.ts` (shared-db path resolution). Full config reference: `docs/cli.md`.

### Desktop — `apps/desktop/`

- `electron/main.ts` — window + platform-service injection (store, sendUpdate, db path)
- `electron/ipc/handlers.ts` — all IPC endpoints: `eval:*`, settings/keys/costs/models/logs/systemPrompts
- `src/` — React renderer; Zustand store in `src/store/evaluationStore.ts`; React Flow graph in `CenterView.tsx`
- `src/types/index.ts` — type-only re-export shim from `@promptengine/core` (keeps `@/types` imports working)

## Key Conventions

- **TypeScript strict mode** with `noUnusedLocals` and `noUnusedParameters` (core + cli; renderer per its own tsconfig)
- React components: PascalCase files. Utilities/hooks: camelCase files.
- UI primitives from shadcn/ui live in `apps/desktop/src/components/ui/`
- CSS: Tailwind utility classes + HSL CSS variables in `apps/desktop/src/index.css`
- API keys stored via electron-store (desktop) or env/config (CLI)
- Every LLM API call is tracked for cost in the evaluation's totals and cost ledger
- Commit messages: no co-author trailers
