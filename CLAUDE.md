# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PromptEngine.AI** — An Electron desktop app that evolves LLM prompts using genetic algorithms. Users configure a test set with fitness metrics (quality, safety, cost, latency, stability), and the app evaluates candidate prompts in parallel across multiple LLM providers (OpenAI, Anthropic, Google Gemini), visualizing the evolution as a generation lineage graph.

**Stack**: Electron 28 + React 18 + TypeScript 5 + Vite 5 + Zustand + TanStack React Query + Tailwind CSS + React Flow + shadcn/ui
**Backend**: Node.js with SQLite (sql.js — WebAssembly, no native modules), electron-store for settings

## Commands

```bash
npm run electron:dev     # Full dev mode (Vite HMR + Electron, port 5173)
npm run dev              # Vite dev server only (no Electron)
npm run type-check       # TypeScript check without emit (tsc --noEmit)
npm run build:strict     # Type-check + Vite build + Electron builder
npm run build:dev        # Type-check + Vite build (no installer)
npm run build            # Vite build + Electron builder (no type-check)
npm test                 # Run all tests (vitest)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
```

Tests use Vitest and live in `tests/unit/`. Run a single test file with `npx vitest run tests/unit/engine/fitness.test.ts`.

## Architecture

### Process Model (Electron IPC)

```
Renderer (React)  <--IPC-->  Main Process (Node.js)
   Zustand store               GA Engine + Providers + SQLite
   React Flow graph             Rate limiter + Semaphore
   shadcn/ui components         electron-store (settings)
```

- **Renderer → Main**: `window.electronAPI.*` calls via context bridge (`electron/preload.ts`)
- **Main → Renderer**: Real-time event streaming via `webContents.send()` per evaluation run
- Context isolation enabled; no nodeIntegration. All network calls happen in main process only.

### Frontend (`src/`)

- **State**: Zustand store (`src/store/evaluationStore.ts`) is the single source of truth. One IPC subscription per evaluation, auto-deduplicated.
- **Async data**: TanStack React Query for evaluation list fetching.
- **Visualization**: React Flow for the generation/node graph (`CenterView.tsx`).
- **Types**: All core types in `src/types/index.ts` (UUID, Provider, EvaluationConfig, CandidateNode, TestCase, etc.)
- **Path alias**: `@/*` maps to `src/*`

### Backend — Genetic Algorithm Engine (`electron/engine/`)

- **Orchestrator**: `evaluator_v2.ts` — main evaluation loop: queue processing, test execution, fitness calculation, generation advancement
- **Generation logic**: `generation.ts` — Top-K/Top-P selection, elitism, parent weighting, child distribution
- **Operators** (each a standalone module):
  - `mutations.ts` — LLM-based prompt mutations with strategy catalog
  - `crossover.ts` — Two-parent prompt merging
  - `metaprompting.ts` — Auto-improvement via LLM feedback
  - `paramvariation.ts` — Temperature/seed variation
  - `modelvariation.ts` — Random model selection
- **Fitness**: `fitness.ts` — Weighted composite of quality, safety, cost, latency, stability
- **Concurrency**: `semaphore.ts` — Global parallel limit enforcement

### Backend — LLM Providers (`electron/providers/`)

Abstract adapter pattern: `base.ts` defines the interface; `openai.ts`, `anthropic.ts`, `gemini.ts` implement it. Factory in `index.ts`. Rate limiting in `rateLimiter.ts`, retry in `retry.ts`, cost lookup in `costs.ts`.

### Persistence (`electron/database/`)

SQLite via sql.js (WebAssembly). `SqlJsWrapper` in `init.ts` provides a better-sqlite3-compatible API (`exec`, `prepare`, `transaction`). Tables: `evaluation_configs`, `evaluation_runs`, `candidate_nodes`, `model_costs`, `app_settings`, `cost_ledger`. Schema + migrations in `init.ts`.

### IPC Handlers (`electron/ipc/handlers.ts`)

All IPC endpoints: `eval:create`, `eval:start`, `eval:pause`, `eval:resume`, `eval:stop`, `eval:list`, `eval:subscribe`, settings/keys/costs/logs/systemPrompts.

## Key Conventions

- **TypeScript strict mode** with `noUnusedLocals` and `noUnusedParameters` enabled
- React components: PascalCase files. Utilities/hooks: camelCase files.
- UI primitives from shadcn/ui live in `src/components/ui/`
- CSS: Tailwind utility classes + HSL CSS variables defined in `src/index.css`
- API keys are stored via electron-store
- Every LLM API call is tracked for cost in the evaluation's totals and cost ledger
