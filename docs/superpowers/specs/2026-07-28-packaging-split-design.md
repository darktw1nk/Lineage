# Packaging Split: npm Workspaces Monorepo (core + cli + desktop)

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

Make PromptEngine.AI packageable as two artifacts sharing one core:

- **CLI on npm** — agents run `npx promptengine --config evolution.json` (or `npm i -g`). Package contains engine + providers + sql.js only. No Electron, no React.
- **Desktop app via electron-builder** (existing NSIS/portable installers) — for humans.

Publishing target: **structure only** — packages are made publishable (metadata, build outputs, `npm pack --dry-run` clean) but NOT published to npm in this phase. The `@promptengine` scope is a placeholder and rename-cheap.

## Current State (verified 2026-07-28)

- Single `private: true` package; CLI runs from source via `tsx cli/index.ts` and imports `../electron/...` and `../src/types/...` directly.
- Engine core (`electron/engine/`, `electron/providers/`, `electron/database/`, `electron/store.ts`) is already nearly Electron-free thanks to Phase 3 seams: `setSendUpdate()`, `setStore()`, `initializeDatabase(customDbPath?)`.
- Exactly three `electron`/`electron-store` references remain in core code (all behind try/catch or dynamic import):
  1. `electron/engine/evaluator_v2.ts` — default `_sendUpdate` does `require('electron')` to find a BrowserWindow.
  2. `electron/database/init.ts` — falls back to `await import('electron')` for the userData path when no `customDbPath` given.
  3. `electron/store.ts` — tries `require('electron-store')` at module load, falls back to a throwing shim.
- Desktop-only modules: `electron/main.ts`, `electron/preload.ts`, `electron/ipc/handlers.ts`, `electron/logger.ts`, `electron/dev-tools/`. None of the engine/provider/database modules import the logger or IPC.
- Shared code used by core at runtime: `src/types/index.ts` (types), `src/utils/distance.ts` (imported by `fitness.ts` and `evaluator_v2.ts`).
- 280 passing tests in `tests/unit/` (Vitest).

## Target Layout

```
D:\projects\evolution2\
├── package.json                 # private root; "workspaces": ["packages/*", "apps/*"]
├── vitest.workspace.ts          # runs all package test suites from root
├── packages/
│   ├── core/                    # @promptengine/core — publishable
│   │   ├── src/
│   │   │   ├── engine/          # from electron/engine/  (9 modules)
│   │   │   ├── providers/       # from electron/providers/ (10 modules)
│   │   │   ├── database/        # from electron/database/init.ts
│   │   │   ├── store.ts         # from electron/store.ts, electron-store ref removed
│   │   │   ├── types.ts         # from src/types/index.ts
│   │   │   ├── utils/
│   │   │   │   └── distance.ts  # from src/utils/distance.ts
│   │   │   └── index.ts         # public API surface
│   │   ├── tests/               # from tests/unit/{engine,providers,database}
│   │   ├── tsup.config.ts
│   │   └── package.json         # deps: sql.js, uuid
│   └── cli/                     # @promptengine/cli — publishable
│       ├── src/                 # from cli/ (index, config, store, database, engine, display, report)
│       ├── tests/               # from tests/unit/cli
│       ├── tsup.config.ts
│       └── package.json         # deps: @promptengine/core; "bin": {"promptengine": "dist/index.js"}
├── apps/
│   └── desktop/                 # private — Electron app
│       ├── electron/            # main.ts, preload.ts, ipc/handlers.ts, logger.ts, dev-tools/
│       ├── src/                 # React renderer, moved as-is
│       │   └── types/index.ts   # becomes: export type * from '@promptengine/core'
│       ├── tests/               # from tests/unit/{store,utils,...} (renderer-side tests)
│       ├── vite.config.ts, tailwind/postcss configs, index.html
│       └── package.json         # deps: @promptengine/core, electron-store, react, ...; electron-builder "build" block
└── docs/, README, ROADMAP unchanged at root
```

## Package Boundaries

### @promptengine/core (publishable)

- **What it does**: the whole evolution engine — GA loop, operators, fitness, provider adapters, cost tracking, sql.js persistence, shared types.
- **Public API** (`index.ts`): `startEvaluation`, `stopEvaluation`, `pauseEvaluation`, `resumeEvaluation`, `setSendUpdate`, `setStore`, `initializeDatabase`, `closeDatabase`, `getDatabase`, provider factory (`getProviderAdapter`), model cost helpers, and all shared types. Deep imports are not part of the contract.
- **Depends on**: `sql.js`, `uuid` only. **Never** `electron` or `electron-store`. (`tiktoken` and `zod` are dead dependencies today — used nowhere in `electron/`, `cli/`, or `src/` — and are dropped from the tree as part of the split.)
- **Platform services are injected by the host** (see Dependency Inversion below).

### @promptengine/cli (publishable)

- **What it does**: arg parsing, JSON config loading, key resolution (env > config > stored), progress display to stderr, JSON results to stdout/file, exit codes. Unchanged behavior from the current `cli/`.
- **Depends on**: `@promptengine/core` (workspace link in dev; semver range when published).
- **Bin**: `promptengine` → `dist/index.js` (shebang preserved).

### apps/desktop (private)

- **What it does**: Electron shell — window management, IPC handlers, preload bridge, logger, React renderer.
- **Depends on**: `@promptengine/core`, `electron`, `electron-store`, React stack.
- Renderer type imports keep working through a one-file shim (`src/types/index.ts` re-exporting types from core), so React components need no edits. Type-only imports are erased at build time and pull no Node code into the browser bundle.

## Dependency Inversion (removing the last 3 Electron threads from core)

1. **store.ts** — core keeps only `StoreInterface`, `setStore()`, and a throwing default ("Store not initialized — host must call setStore()"). The `require('electron-store')` block moves to `apps/desktop/electron/main.ts`, which calls `setStore(new Store({...}))` during startup (same encryptionKey, so existing user settings files keep working). `electron-store` moves from root deps to desktop deps. CLI keeps its existing shim via `setStore()`.
2. **evaluator_v2.ts** — default `_sendUpdate` becomes a no-op. Desktop `main.ts` (or handler setup) injects the BrowserWindow sender via the existing `setSendUpdate()`. CLI already injects its own.
3. **database/init.ts** — `initializeDatabase(dbPath: string)` makes the path **required**; the `await import('electron')` fallback is deleted. Desktop computes `path.join(app.getPath('userData'), 'evolution.db')` itself and passes it (same file location as today — no data migration). CLI already passes a path (or its own default).

## Build Tooling

- **Core & CLI**: `tsup` per package — ESM output + `.d.ts`, `"type": "module"`, `"exports"` map, `"files": ["dist"]`. sql.js stays a regular dependency; in Node it resolves its own `.wasm` from `node_modules` (no bundling of WASM).
- **CLI in dev**: root script `npm run cli` keeps working, defined as `tsx packages/cli/src/index.ts` (source-run, no build step needed during development).
- **Desktop**: `vite.config.ts`, `vite-plugin-electron`, and the electron-builder `build` block move into `apps/desktop/package.json`. Root `npm run electron:dev` / `npm run build` delegate via `npm run <script> -w apps/desktop`. electron-builder resolves the workspace-hoisted `@promptengine/core` like any other dependency.
- **Publish-readiness** (not publishing yet): each publishable package gets `license: "MIT"`, `repository`, `description`, README stub; acceptance check is a clean `npm pack --dry-run` per package and a successful `npm link`-style smoke run of the CLI from the packed tarball.
- **TypeScript**: per-package `tsconfig.json` extending a root base config. Root `npm run type-check` checks all workspaces.

## Tests

- Tests move with their subjects: `tests/unit/{engine,providers,database}` → `packages/core/tests/`; `tests/unit/cli` → `packages/cli/tests/`; renderer/store/util tests → `apps/desktop/tests/`.
- Import paths inside tests update from `../../../electron/...` to core-relative paths; mocking patterns (`vi.mock` of providers/store) are unchanged in shape.
- Root `vitest.workspace.ts` lets `npm test` at the root run every suite; each package can also run its own.
- **Definition of done for the split**: all 280 existing tests pass from their new homes, `npm run type-check` clean, `npm run electron:dev` boots the app, CLI runs an evolution from a packed tarball.

## Error Handling & Edge Cases

- **Uninitialized store in core**: throwing default with an actionable message naming `setStore()` — same behavior CLI mode has today.
- **Missing db path**: `initializeDatabase` without a path is now a compile-time error for consumers; no silent Electron fallback.
- **electron-builder + workspaces**: hoisted `node_modules` resolution is the known risk; mitigation is keeping desktop's `files`/`asarUnpack` config explicit and smoke-testing the built installer once during implementation.
- **Windows paths / shebang**: npm generates `.cmd` shims for bins on Windows; nothing extra needed.
- **Existing user data**: desktop keeps the same userData db path and electron-store encryptionKey — upgrades see their existing evaluations and keys.

## Out of Scope

- Publishing to npm (structure only; naming is placeholder).
- Web UI / serving the UI from the CLI.
- Plugin system (Phase 5), README/demo polish (Phase 4) — though the workspace split is written up so Phase 4 docs can point at `packages/`.
- Any engine behavior changes.
