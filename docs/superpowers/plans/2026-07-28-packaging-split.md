# Packaging Split Implementation Plan (npm workspaces: core + cli + desktop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repo into an npm-workspaces monorepo — publishable `@promptengine/core` + `@promptengine/cli` packages and a private Electron app — per the approved spec at `D:\projects\evolution2\docs\superpowers\specs\2026-07-28-packaging-split-design.md`.

**Architecture:** First invert the last three Electron references out of the engine (host injects store, update-sender, and db path), then move the engine into `packages/core`, the CLI into `packages/cli`, and the Electron app into `apps/desktop`, updating imports to the `@promptengine/core` package specifier resolved via tsconfig paths / vite aliases in dev and via built `dist/` for published consumers.

**Tech Stack:** npm workspaces (plain npm — NOT pnpm/yarn), TypeScript 5.3 strict ESM, tsup (esbuild) for package builds, Vitest 4 with `test.projects`, Vite 5 + vite-plugin-electron + electron-builder for the desktop app, sql.js (WASM), tsx for CLI dev runs.

## Global Constraints

- **Commit messages: NEVER add `Co-Authored-By`** or any attribution trailer — just the message (user's global rule).
- **Never `git add -A` or `git add .`** — the repo root is full of untracked scratch files (`test-*.ts`, `stt-*.json`, `shrine/`, `nul`, etc.). Stage only the exact paths each step names. Do not modify, move, or delete untracked scratch files.
- Use `git mv` for every file move (preserves history).
- Plain npm workspaces semantics: local dependency ranges are normal semver (`"^1.0.0"`), never `workspace:*` protocol.
- All packages are ESM (`"type": "module"`); relative import specifiers keep the `.js` extension convention used throughout the codebase.
- `@promptengine/*` names are placeholders (not published in this phase). Do NOT run `npm publish`.
- The desktop app package MUST keep `"name": "evolution2"` — Electron derives the dev userData path (`%APPDATA%\evolution2`) from it, and `packages/cli/src/database.ts` (`getElectronDbPath()`) plus existing users' databases depend on that exact folder name.
- Preserve the electron-store `encryptionKey: 'prompt-evolution-secure-key'` and the db filename `evolution.db` — existing user data must keep loading.
- After every task: `npm test` green (280 pre-existing tests + tests added by Task 1) and type-check green. TypeScript strict mode with `noUnusedLocals`/`noUnusedParameters` stays on.
- Commands below are written for the Bash tool (git bash on Windows). Paths in commands are repo-root-relative; the repo root is `D:\projects\evolution2`.
- Node >= 20 is the floor for `engines` fields.

---

### Task 1: Invert the last three Electron references out of the engine

The engine code (future `@promptengine/core`) still reaches for Electron in three places, each behind a try/catch or dynamic import. Replace all three with host injection, and wire the Electron app to inject. After this task the engine has zero `electron` / `electron-store` references while still living in its current directories.

**Files:**
- Create: `tests/unit/store/store.test.ts`
- Create: `tests/unit/database/init-path.test.ts`
- Modify: `electron/store.ts`
- Modify: `electron/engine/evaluator_v2.ts:59-73` (default `_sendUpdate`)
- Modify: `electron/database/init.ts:168-177` (`initializeDatabase` signature)
- Modify: `electron/main.ts` (inject store, sendUpdate, db path)

**Interfaces:**
- Consumes: existing seams `setStore(s: StoreInterface): void`, `setSendUpdate(fn: (runId: UUID, data: any) => void): void`, `initializeDatabase(customDbPath?: string): Promise<void>`.
- Produces (later tasks rely on these exact signatures):
  - `export interface StoreInterface { get(key: string): any; set(key: string, value: any): void; store: Record<string, any>; }` — now **exported** from `electron/store.ts`.
  - `export async function initializeDatabase(dbPath: string): Promise<void>` — path is **required**; throws `Error('initializeDatabase requires a database file path')` on empty string.
  - Default `_sendUpdate` in `evaluator_v2.ts` is a no-op (no `require('electron')`).

- [ ] **Step 1: Write the contract tests (new files)**

`tests/unit/store/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { store, setStore } from '../../../electron/store.js';

// NOTE: module-level singleton — these tests run in order within this file.
describe('core store (host-injected)', () => {
  it('throws an actionable error when used before setStore()', () => {
    expect(() => store.get('apiKeys')).toThrow(/setStore/);
    expect(() => store.set('x', 1)).toThrow(/setStore/);
  });

  it('delegates to the injected store after setStore()', () => {
    const backing: Record<string, any> = {};
    setStore({
      get: (k: string) => backing[k],
      set: (k: string, v: any) => { backing[k] = v; },
      store: backing,
    });
    store.set('apiKeys', { openai: 'k' });
    expect(store.get('apiKeys')).toEqual({ openai: 'k' });
    expect(store.store).toBe(backing);
  });
});
```

`tests/unit/database/init-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { initializeDatabase } from '../../../electron/database/init.js';

describe('initializeDatabase', () => {
  it('rejects an empty database path instead of falling back to Electron', async () => {
    await expect(initializeDatabase('')).rejects.toThrow(/requires a database file path/);
  });
});
```

- [ ] **Step 2: Run the new tests — expect the db-path test to FAIL**

Run: `npx vitest run tests/unit/store/store.test.ts tests/unit/database/init-path.test.ts`
Expected: `init-path.test.ts` FAILS (current code falls back to `await import('electron')` and dies with a `TypeError` about `getPath`, which doesn't match the required message). The store test may already pass in the Node environment (the `require('electron-store')` try-branch fails outside Electron) — it pins the contract; that's fine.

- [ ] **Step 3: Rewrite `electron/store.ts`** (full new content — removes the `electron-store` require, exports the interface):

```ts
/**
 * Store module — provides a key/value store for API keys and settings.
 *
 * The host application must inject an implementation via setStore() before
 * any provider or engine code accesses settings:
 *   - Electron app: setStore(new ElectronStore(...)) in main.ts
 *   - CLI: setStore(createCliStore(...))
 */

export interface StoreInterface {
  get(key: string): any;
  set(key: string, value: any): void;
  store: Record<string, any>;
}

let _store: StoreInterface = {
  get() { throw new Error('Store not initialized. The host must call setStore() before accessing settings.'); },
  set() { throw new Error('Store not initialized. The host must call setStore() before accessing settings.'); },
  store: {},
};

export const store: StoreInterface = new Proxy({} as StoreInterface, {
  get(_target, prop: string) {
    return (typeof (_store as any)[prop] === 'function')
      ? (...args: any[]) => (_store as any)[prop](...args)
      : (_store as any)[prop];
  },
});

export function setStore(s: StoreInterface): void {
  _store = s;
}
```

- [ ] **Step 4: Replace the default `_sendUpdate` in `electron/engine/evaluator_v2.ts`**

Replace lines 59–73 (the block from the `/** Pluggable update sender...` comment through the closing `};` of the default function) with:

```ts
/**
 * Pluggable update sender. Defaults to a no-op; the host injects a real
 * sender via setSendUpdate() (Electron: BrowserWindow IPC; CLI: collector).
 */
let _sendUpdate: (runId: UUID, data: any) => void = () => {
  // No-op until the host injects a sender via setSendUpdate().
};
```

- [ ] **Step 5: Make the db path required in `electron/database/init.ts`**

Replace the signature and the path-resolution block (lines 168–177, from `export async function initializeDatabase` through the closing brace of the `else`) with:

```ts
export async function initializeDatabase(dbPath: string): Promise<void> {
  if (!dbPath) {
    throw new Error('initializeDatabase requires a database file path');
  }
```

(The following line `fs.mkdirSync(path.dirname(dbPath), { recursive: true });` and the rest of the function stay unchanged — delete the now-unused `let dbPath: string;` / `customDbPath` logic and the `await import('electron')` fallback entirely.)

- [ ] **Step 6: Wire injection in `electron/main.ts`** (full new content):

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { initializeDatabase, closeDatabase } from './database/init.js';
import { setStore, type StoreInterface } from './store.js';
import { setSendUpdate } from './engine/evaluator_v2.js';
import { registerIPCHandlers } from './ipc/handlers.js';
import { initLogger, getLogBuffer } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize logger early to capture all logs
initLogger();

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.0,
      disableBlinkFeatures: 'Accelerated2dCanvas',
    },
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  // Inject platform services into the engine (host-provided: store, update sender, db path)
  setStore(new Store({ encryptionKey: 'prompt-evolution-secure-key' }) as unknown as StoreInterface);

  setSendUpdate((runId, data) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(`eval:updates:${runId}`, data);
    }
  });

  await initializeDatabase(path.join(app.getPath('userData'), 'evolution.db'));

  // Register IPC handlers
  registerIPCHandlers(ipcMain);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  closeDatabase();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

(`getLogBuffer` stays imported exactly as before — `tsconfig.node.json` does not enforce `noUnusedLocals`.)

- [ ] **Step 7: Full verification**

Run: `npx vitest run` — Expected: all tests pass (280 + 3 new).
Run: `npm run type-check` — Expected: clean.
Run: `grep -rn "electron-store\|require('electron')\|import('electron')" electron/engine electron/providers electron/database electron/store.ts` — Expected: **no matches** (core is Electron-free).

- [ ] **Step 8: Smoke-test the desktop app still boots**

Run: `npm run electron:dev` in the background; wait ~25s; confirm the Electron window process is up and the terminal shows the Vite dev server ready with no uncaught exception / stack trace mentioning `initializeDatabase`, `setStore`, or `Store`; then kill the process tree. (Evaluation list loading proves the injected store + db path work.)

- [ ] **Step 9: Commit**

```bash
git add electron/store.ts electron/engine/evaluator_v2.ts electron/database/init.ts electron/main.ts tests/unit/store/store.test.ts tests/unit/database/init-path.test.ts
git commit -m "Invert Electron dependencies out of engine core (store, sendUpdate, db path injection)"
```

---

### Task 2: Create the workspace skeleton and move the engine into packages/core

Move engine/providers/database/store/types/distance into `packages/core`, give it a package.json + configs, add npm workspaces at the root, and point every consumer (electron main/handlers, CLI, renderer type shim, tests) at `@promptengine/core`. Ends green: all tests pass from new locations.

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsup.config.ts`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`
- Create: `tsconfig.base.json`, `vitest.legacy.config.ts` (transitional root test project)
- Create: `src/types/index.ts` (renderer type shim, replaces moved file)
- Move (git mv): `electron/engine → packages/core/src/engine`, `electron/providers → packages/core/src/providers`, `electron/database → packages/core/src/database`, `electron/store.ts → packages/core/src/store.ts`, `src/types/index.ts → packages/core/src/types.ts`, `src/utils/distance.ts → packages/core/src/utils/distance.ts`, `tests/unit/engine → packages/core/tests/engine`, `tests/unit/providers → packages/core/tests/providers`, `tests/unit/database → packages/core/tests/database`, `tests/unit/store → packages/core/tests/store`, `tests/unit/utils/distance.test.ts → packages/core/tests/utils/distance.test.ts`
- Modify: root `package.json` (workspaces), root `tsconfig.json` + `tsconfig.node.json` (paths), root `vitest.config.ts` (projects), `vite.config.ts` (aliases incl. electron main sub-build), `electron/main.ts`, `electron/ipc/handlers.ts`, `electron/dev-tools/createTestEvaluations.ts`, all 7 `cli/*.ts`, `tests/unit/cli/*.test.ts`

**Interfaces:**
- Consumes: Task 1's `StoreInterface`, no-op sendUpdate default, required-path `initializeDatabase`.
- Produces: package `@promptengine/core` whose index exports exactly:

```ts
// packages/core/src/index.ts
export type * from './types.js';
export { store, setStore } from './store.js';
export type { StoreInterface } from './store.js';
export { SqlJsWrapper, getDatabase, initializeDatabase, closeDatabase } from './database/init.js';
export {
  setSendUpdate,
  startEvaluation,
  pauseEvaluation,
  resumeEvaluation,
  stopEvaluation,
} from './engine/evaluator_v2.js';
export { initGlobalSemaphore, updateGlobalSemaphoreLimit, withGlobalSemaphore } from './engine/semaphore.js';
export { getProviderAdapter } from './providers/index.js';
export { OpenRouterAdapter } from './providers/openrouter.js';
export type { OpenRouterModel } from './providers/openrouter.js';
export { getModelCost } from './providers/costs.js';
export { withRetry, isRetryableError, RetryableError } from './providers/retry.js';
export type { RetryOptions } from './providers/retry.js';
export { levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from './utils/distance.js';
```

  Later tasks import ONLY these names from `@promptengine/core`. Deep imports are not part of the contract.

- [ ] **Step 1: Create `tsconfig.base.json`** at the repo root:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

- [ ] **Step 2: Move the core sources and tests**

```bash
mkdir -p packages/core/src packages/core/tests
git mv electron/engine packages/core/src/engine
git mv electron/providers packages/core/src/providers
git mv electron/database packages/core/src/database
git mv electron/store.ts packages/core/src/store.ts
git mv src/types/index.ts packages/core/src/types.ts
git mv src/utils/distance.ts packages/core/src/utils/distance.ts
git mv tests/unit/engine packages/core/tests/engine
git mv tests/unit/providers packages/core/tests/providers
git mv tests/unit/database packages/core/tests/database
git mv tests/unit/store packages/core/tests/store
mkdir -p packages/core/tests/utils
git mv tests/unit/utils/distance.test.ts packages/core/tests/utils/distance.test.ts
```

(`git mv src/types/index.ts` may leave an empty `src/types/` dir — that's fine, Step 8 recreates the shim there. `src/utils/cn.ts` and `tests/unit/utils/cn.test.ts` stay put.)

- [ ] **Step 3: Rewrite intra-core imports** (old paths pointed out of the electron/ dir):

```bash
# engine/providers/database files: ../../src/types/index.js -> ../types.js
find packages/core/src -name '*.ts' -exec sed -i 's|\.\./\.\./src/types/index.js|../types.js|g' {} +
# fitness.ts static + evaluator_v2.ts dynamic imports of distance
find packages/core/src -name '*.ts' -exec sed -i 's|\.\./\.\./src/utils/distance.js|../utils/distance.js|g' {} +
```

Then verify no stale specifiers remain: `grep -rn "src/types\|src/utils" packages/core/src` — Expected: no matches.

- [ ] **Step 4: Rewrite core test imports**

```bash
find packages/core/tests -name '*.test.ts' -exec sed -i 's|\.\./\.\./\.\./electron/|../../src/|g' {} +
find packages/core/tests -name '*.test.ts' -exec sed -i 's|\.\./\.\./\.\./src/types/index.js|../../src/types.js|g' {} +
find packages/core/tests -name '*.test.ts' -exec sed -i 's|\.\./\.\./\.\./src/utils/distance.js|../../src/utils/distance.js|g' {} +
```

This covers both plain imports and `vi.mock('../../../electron/...')` targets (Vitest mocks by resolved file, so relative mock paths keep working after the uniform rewrite). Verify: `grep -rn "electron/" packages/core/tests` — Expected: no matches.

- [ ] **Step 5: Create `packages/core/src/index.ts`** with the exact content from the Interfaces block above.

- [ ] **Step 6: Create the core package files**

`packages/core/package.json`:

```json
{
  "name": "@promptengine/core",
  "version": "1.0.0",
  "description": "Genetic-algorithm engine for LLM prompt optimization: operators, fitness, providers, persistence.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "sql.js": "^1.14.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/sql.js": "^1.4.9",
    "@types/uuid": "^9.0.7",
    "tsup": "^8.0.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src"]
}
```

`packages/core/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
});
```

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 7: Root workspace + config updates**

In root `package.json` add (top level, after `"private": true` is fine):

```json
"workspaces": ["packages/*", "apps/*"]
```

In root `tsconfig.json`, extend `paths`:

```json
"paths": {
  "@/*": ["src/*"],
  "@promptengine/core": ["packages/core/src/index.ts"]
}
```

In `tsconfig.node.json`, add inside `compilerOptions`:

```json
"paths": {
  "@promptengine/core": ["./packages/core/src/index.ts"]
}
```

Replace root `vitest.config.ts` content with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', './vitest.legacy.config.ts'],
  },
});
```

Create `vitest.legacy.config.ts` (hosts the not-yet-moved cli + renderer-util tests):

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@promptengine/core': path.resolve(__dirname, './packages/core/src/index.ts'),
    },
  },
  test: {
    name: 'legacy-root',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

(The old root `coverage.include` list referenced pre-move paths; coverage configuration is intentionally dropped here — `test:coverage` still runs with default settings.)

In `vite.config.ts`: add the core alias to the top-level `resolve.alias` AND to the **main-process entry's** sub-config (vite-plugin-electron sub-builds do NOT inherit root `resolve`):

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@promptengine/core': path.resolve(__dirname, './packages/core/src/index.ts')
  }
},
```

and for the `electron/main.ts` entry:

```ts
{
  entry: 'electron/main.ts',
  vite: {
    resolve: {
      alias: {
        '@promptengine/core': path.resolve(__dirname, './packages/core/src/index.ts')
      }
    },
    build: {
      outDir: 'dist-electron',
      rollupOptions: {
        external: ['sql.js']
      }
    }
  }
},
```

(The preload entry imports nothing from core — leave it untouched.)

- [ ] **Step 8: Renderer type shim** — create a new `src/types/index.ts`:

```ts
// Type-only re-export: erased at build time, pulls no engine code into the renderer.
export type * from '@promptengine/core';
```

- [ ] **Step 9: Point desktop + CLI consumers at `@promptengine/core`**

`electron/main.ts` — replace the three engine imports from Task 1 with:

```ts
import { initializeDatabase, closeDatabase, setStore, setSendUpdate, type StoreInterface } from '@promptengine/core';
```

(delete the separate `./database/init.js`, `./store.js`, `./engine/evaluator_v2.js` import lines; everything else stays.)

`electron/ipc/handlers.ts` — replace lines 2, 3, 5, 7 with:

```ts
import type { EvaluationConfig, EvaluationRun, ModelRef, ModelCostEntry, AppSettings } from '@promptengine/core';
import { getDatabase, store, OpenRouterAdapter } from '@promptengine/core';
```

and replace all four dynamic evaluator imports (lines ~215, 226, 231, 236) — `await import('../engine/evaluator_v2.js')` → `await import('@promptengine/core')`. The `../dev-tools/createTestEvaluations.js` dynamic import stays relative (desktop-side module).

`electron/dev-tools/createTestEvaluations.ts` — change its imports of `../../src/types/index.js` and `../database/init.js` to `@promptengine/core`.

`cli/*.ts` (all 7 files) — mechanical rewrite:

```bash
find cli -name '*.ts' -exec sed -i "s|'\.\./src/types/index.js'|'@promptengine/core'|g; s|'\.\./electron/store.js'|'@promptengine/core'|g; s|'\.\./electron/engine/evaluator_v2.js'|'@promptengine/core'|g; s|'\.\./electron/database/init.js'|'@promptengine/core'|g" {} +
```

Verify nothing stale anywhere: `grep -rEn "\.\./electron/|\.\./(engine|providers|database)/|\.\./store\.js|\.\./src/types|\.\./\.\./src/(types|utils)" cli/ src/ electron/ --include='*.ts'` — Expected: no matches except `electron/ipc/handlers.ts`'s `../dev-tools/createTestEvaluations.js` line (desktop-internal, correct).

- [ ] **Step 10: Update CLI tests' mocks** (they mocked granular internal modules; CLI now imports the package index, so the three mocks in `tests/unit/cli/engine.test.ts` merge into ONE). Replace the imports + three `vi.mock` blocks (lines 2, 12–35) with:

```ts
import type { EvaluationConfig, CandidateNode, UUID } from '@promptengine/core';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStartEvaluation = vi.fn();
const mockStopEvaluation = vi.fn();
let capturedSendUpdate: ((runId: UUID, data: any) => void) | null = null;

const mockDbPrepare = vi.fn();
const mockDbRun = vi.fn();

vi.mock('@promptengine/core', () => ({
  setSendUpdate: (fn: (runId: UUID, data: any) => void) => {
    capturedSendUpdate = fn;
  },
  startEvaluation: (...args: any[]) => mockStartEvaluation(...args),
  stopEvaluation: (...args: any[]) => mockStopEvaluation(...args),
  getDatabase: () => ({
    prepare: (sql: string) => {
      mockDbPrepare(sql);
      return { run: (...args: any[]) => mockDbRun(sql, ...args) };
    },
  }),
  closeDatabase: vi.fn(),
  setStore: vi.fn(),
}));
```

In the other CLI test files (`config.test.ts`, `store.test.ts`, `display.test.ts`), rewrite any `'../../../src/types/index.js'` import to `'@promptengine/core'` (type-only imports are unaffected by the mock).

- [ ] **Step 11: Install workspaces and verify**

```bash
npm install        # links node_modules/@promptengine/core, regenerates package-lock.json (large diff is expected)
npx vitest run     # ALL projects: core package + legacy root
npm run type-check # root tsc; then also: npx tsc -p packages/core
```

Expected: every pre-existing test + Task 1's tests pass; both type-checks clean.

- [ ] **Step 12: Desktop smoke** — same procedure as Task 1 Step 8 (`npm run electron:dev`, ~25s, no startup stack traces, kill).

- [ ] **Step 13: Commit**

```bash
git add packages/core tsconfig.base.json vitest.legacy.config.ts vitest.config.ts vite.config.ts tsconfig.json tsconfig.node.json package.json package-lock.json src/types/index.ts electron/main.ts electron/ipc/handlers.ts electron/dev-tools/createTestEvaluations.ts cli/ tests/unit/cli/
git commit -m "Extract engine into @promptengine/core workspace package"
```

(Note: the `git mv` moves are already staged by `git mv` itself; the `git add` above picks up the edits on top.)

---

### Task 3: Move the CLI into packages/cli with a `promptengine` bin

**Files:**
- Move (git mv): `cli/*.ts → packages/cli/src/`, `tests/unit/cli → packages/cli/tests`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsup.config.ts`, `packages/cli/vitest.config.ts`
- Modify: root `package.json` (`cli` script), `docs/cli.md` (paths), `vitest.legacy.config.ts` reference stays (still hosts `tests/unit/utils/cn.test.ts`)

**Interfaces:**
- Consumes: `@promptengine/core` index exports (Task 2 list) — CLI files already import the package specifier after Task 2.
- Produces: `@promptengine/cli` package with `"bin": {"promptengine": "./dist/index.js"}`; root script `"cli": "tsx packages/cli/src/index.ts"`. Intra-CLI relative imports (`./config.js`, `./store.js`, …) are unchanged by the move.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/cli/src
for f in index config store database engine display report; do git mv "cli/$f.ts" "packages/cli/src/$f.ts"; done
rmdir cli
git mv tests/unit/cli packages/cli/tests
```

- [ ] **Step 2: Fix CLI test relative paths** (tests sat 3 levels from repo root, now 2 levels from package root):

```bash
find packages/cli/tests -name '*.test.ts' -exec sed -i 's|\.\./\.\./\.\./cli/|../src/|g' {} +
```

Verify: `grep -rn "\.\./cli/\|\.\./\.\./\.\./" packages/cli/tests` — Expected: no matches.

- [ ] **Step 3: Create the package files**

`packages/cli/package.json`:

```json
{
  "name": "@promptengine/cli",
  "version": "1.0.0",
  "description": "Command-line runner for PromptEngine.AI prompt evolution — for CI, scripts, and AI agents.",
  "license": "MIT",
  "type": "module",
  "bin": { "promptengine": "./dist/index.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@promptengine/core": "^1.0.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.7",
    "tsup": "^8.0.0"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@promptengine/core": ["../core/src/index.ts"] }
  },
  "include": ["src"]
}
```

`packages/cli/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
});
```

(tsup preserves the `#!/usr/bin/env node` shebang from `src/index.ts` and marks the output executable; `@promptengine/core` and `uuid` are auto-externalized as dependencies.)

`packages/cli/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@promptengine/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Root script update** — in root `package.json` change:

```json
"cli": "tsx packages/cli/src/index.ts"
```

- [ ] **Step 5: Update `docs/cli.md`** — the "Usage" section's command stays `npm run cli -- ...` (unchanged behavior); update the one line referencing the old source path `cli/index.ts` (if present) to `packages/cli/src/index.ts`.

- [ ] **Step 6: Verify**

```bash
npm install                      # re-link workspaces (adds @promptengine/cli)
npx vitest run                   # all projects incl. packages/cli
npx tsc -p packages/cli          # clean
npm run cli -- --help            # prints the help text, exit 0
```

If `npm run cli` fails with a module-resolution error on `@promptengine/core` (tsx not picking up tsconfig paths), change the script to `"cli": "tsx --tsconfig packages/cli/tsconfig.json packages/cli/src/index.ts"` and re-verify.

- [ ] **Step 7: Commit**

```bash
git add packages/cli package.json package-lock.json docs/cli.md
git commit -m "Move CLI into @promptengine/cli workspace package with promptengine bin"
```

---

### Task 4: Move the Electron app into apps/desktop and slim the root

**Files:**
- Move (git mv): `electron → apps/desktop/electron`, `src → apps/desktop/src`, `index.html`, `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json → apps/desktop/tsconfig.json`, `tsconfig.node.json → apps/desktop/tsconfig.node.json`, `tests/unit/utils/cn.test.ts → apps/desktop/tests/utils/cn.test.ts`; also `components.json` and `public/` **if they exist** (check with `ls`)
- Create: `apps/desktop/package.json`, `apps/desktop/vitest.config.ts`
- Modify: root `package.json` (slim deps, delegate scripts, drop `build` block, rename root to `promptengine-monorepo`), root `vitest.config.ts` (final projects list), delete `vitest.legacy.config.ts`
- Delete: root `tests/` dir remnants (should be empty after the move — verify before removing)

**Interfaces:**
- Consumes: `@promptengine/core` exports (already wired in Task 2 — desktop imports move as-is).
- Produces: workspace app named **`evolution2`** (MUST keep this name — see Global Constraints) with scripts `dev`, `electron:dev`, `build`, `build:dev`; root scripts delegate with `-w`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/desktop
git mv electron apps/desktop/electron
git mv src apps/desktop/src
git mv index.html apps/desktop/index.html
git mv vite.config.ts apps/desktop/vite.config.ts
git mv tailwind.config.js apps/desktop/tailwind.config.js
git mv postcss.config.js apps/desktop/postcss.config.js
git mv tsconfig.json apps/desktop/tsconfig.json
git mv tsconfig.node.json apps/desktop/tsconfig.node.json
mkdir -p apps/desktop/tests/utils
git mv tests/unit/utils/cn.test.ts apps/desktop/tests/utils/cn.test.ts
ls components.json public 2>/dev/null && { git mv components.json apps/desktop/components.json 2>/dev/null; git mv public apps/desktop/public 2>/dev/null; } || true
```

Then check the root `tests/` tree is empty and remove leftovers: `find tests -type f` — Expected: nothing; then `rm -rf tests`.

- [ ] **Step 2: Create `apps/desktop/package.json`** (name stays `evolution2`; dependencies = old root runtime deps with `tiktoken` and `zod` dropped as dead, and `sql.js` kept — the bundled main.js marks it `external`, so it must exist in node_modules at runtime):

```json
{
  "name": "evolution2",
  "version": "1.0.0",
  "description": "PromptEngine.AI desktop app - Genetic Algorithm for LLM Prompt Optimization",
  "private": true,
  "type": "module",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "electron:dev": "concurrently \"npm run dev\" \"wait-on http://localhost:5173 && electron .\"",
    "build": "vite build && electron-builder",
    "build:dev": "vite build",
    "test": "vitest run",
    "type-check": "tsc --noEmit && tsc -p tsconfig.node.json"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.0.5",
    "@radix-ui/react-dropdown-menu": "^2.0.6",
    "@radix-ui/react-label": "^2.0.2",
    "@radix-ui/react-select": "^2.0.0",
    "@radix-ui/react-slot": "^1.0.2",
    "@radix-ui/react-switch": "^1.0.3",
    "@radix-ui/react-tabs": "^1.0.4",
    "@radix-ui/react-toast": "^1.1.5",
    "@radix-ui/react-tooltip": "^1.2.8",
    "@tanstack/react-query": "^5.17.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "d3": "^7.8.5",
    "electron-store": "^8.1.0",
    "lucide-react": "^0.307.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "reactflow": "^11.11.4",
    "sonner": "^2.0.7",
    "sql.js": "^1.14.0",
    "tailwind-merge": "^2.2.0",
    "uuid": "^9.0.1",
    "zustand": "^4.4.7"
  },
  "devDependencies": {
    "@promptengine/core": "^1.0.0",
    "@types/d3": "^7.4.3",
    "@types/react": "^18.2.46",
    "@types/react-dom": "^18.2.18",
    "@types/sql.js": "^1.4.9",
    "@types/uuid": "^9.0.7",
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.16",
    "concurrently": "^8.2.2",
    "electron": "^28.1.0",
    "electron-builder": "^24.9.1",
    "postcss": "^8.4.32",
    "tailwindcss": "^3.4.0",
    "vite": "^5.0.10",
    "vite-plugin-electron": "^0.28.1",
    "vite-plugin-electron-renderer": "^0.14.5",
    "wait-on": "^7.2.0"
  },
  "build": {
    "appId": "com.promptengine.evolution",
    "productName": "PromptEngine.AI",
    "directories": { "output": "release" },
    "files": ["dist/**/*", "dist-electron/**/*", "package.json"],
    "win": {
      "target": [
        { "target": "nsis", "arch": ["x64"] },
        { "target": "portable", "arch": ["x64"] }
      ],
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    },
    "portable": { "artifactName": "PromptEngine-${version}-portable.exe" }
  }
}
```

`@promptengine/core` sits in **devDependencies** deliberately: the vite main-process build bundles core source via alias, so the packaged app never needs the workspace symlink (which electron-builder can't pack reliably); `sql.js` is a real dependency because it stays `external` in the main bundle.

- [ ] **Step 3: Fix paths in `apps/desktop/vite.config.ts`** — the two core aliases change from `./packages/core/...` to `../../packages/core/...`:

```ts
'@promptengine/core': path.resolve(__dirname, '../../packages/core/src/index.ts')
```

(both in top-level `resolve.alias` and in the `electron/main.ts` entry's sub-config; the `'@'` alias stays `./src` — correct relative to the moved config).

In `apps/desktop/tsconfig.json` (this is the moved full former-root config — do NOT switch it to extend `tsconfig.base.json`; it keeps its own `jsx`/`lib` settings), update only its `paths`:

```json
"paths": {
  "@/*": ["src/*"],
  "@promptengine/core": ["../../packages/core/src/index.ts"]
}
```

and delete the `"references"` line's path change — it stays `{ "path": "./tsconfig.node.json" }` (moved alongside, still correct). In `apps/desktop/tsconfig.node.json` update its paths mapping to `"@promptengine/core": ["../../packages/core/src/index.ts"]` (its `include: ["vite.config.ts", "electron"]` remains correct relative to its new home).

- [ ] **Step 4: Create `apps/desktop/vitest.config.ts`**:

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@promptengine/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

Fix the moved test's import depth: in `apps/desktop/tests/utils/cn.test.ts` rewrite `'../../../src/utils/cn.js'` → `'../../src/utils/cn.js'` (or its `@/utils/cn` form stays working via the alias — check the file and adjust whichever specifier it uses).

- [ ] **Step 5: Rewrite the root `package.json`** (full new content — root becomes a pure workspace host):

```json
{
  "name": "promptengine-monorepo",
  "version": "1.0.0",
  "description": "PromptEngine.AI - Genetic Algorithm for LLM Prompt Optimization",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "npm run dev -w apps/desktop",
    "electron:dev": "npm run electron:dev -w apps/desktop",
    "build": "npm run build -w apps/desktop",
    "build:dev": "npm run type-check && npm run build:dev -w apps/desktop",
    "build:strict": "npm run type-check && npm run build -w apps/desktop",
    "build:packages": "npm run build -w packages/core -w packages/cli",
    "type-check": "tsc -p packages/core && tsc -p packages/cli && tsc -p apps/desktop && tsc -p apps/desktop/tsconfig.node.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "cli": "tsx packages/cli/src/index.ts"
  },
  "devDependencies": {
    "@types/node": "^20.10.6",
    "@vitest/coverage-v8": "^4.0.18",
    "sharp": "^0.34.5",
    "tsx": "^4.21.0",
    "typescript": "^5.3.3",
    "vitest": "^4.0.18"
  }
}
```

(`sharp` stays at root — it's used by local image scripts, not by any package. `tiktoken`, `zod`, and the root copies of all moved deps are gone. If Task 3 ended with the `--tsconfig` variant of the `cli` script, keep that variant here.)

Update root `vitest.config.ts` to the final projects list and delete the legacy config:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop'],
  },
});
```

```bash
git rm vitest.legacy.config.ts
```

- [ ] **Step 6: Reinstall and verify everything**

```bash
npm install                        # re-hoist; expect electron postinstall to run
npx vitest run                     # all three projects green
npm run type-check                 # all four tsc invocations clean
npm run cli -- --help              # CLI still runs from root
```

- [ ] **Step 7: Desktop smoke** — `npm run electron:dev` from the root; window boots with no startup errors; kill. Windows note: if `wait-on` fails because the vite port differs, check `apps/desktop/vite.config.ts` still pins `server.port: 5173`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop package.json package-lock.json vitest.config.ts
git commit -m "Move Electron app into apps/desktop workspace; slim root to workspace host"
```

---

### Task 5: Publish-readiness, package builds, tarball smoke test, docs

**Files:**
- Create: `LICENSE` (root), `packages/core/README.md`, `packages/cli/README.md`
- Modify: `packages/core/package.json` + `packages/cli/package.json` (add `repository` only if `git remote -v` shows one), `CLAUDE.md` (commands + architecture paths), `docs/cli.md` (install section)

**Interfaces:**
- Consumes: tsup configs from Tasks 2–3; bin contract `promptengine` → `dist/index.js`.
- Produces: `npm pack`-clean packages; verified install-from-tarball CLI run.

- [ ] **Step 1: Add `LICENSE`** at the root (MIT, `Copyright (c) 2026 Alexander Goncharov`), standard MIT text. Copy it into both packages:

```bash
cp LICENSE packages/core/LICENSE
cp LICENSE packages/cli/LICENSE
```

(npm auto-includes LICENSE in packs; no `files` change needed.)

- [ ] **Step 2: Write the package READMEs**

`packages/core/README.md`:

```markdown
# @promptengine/core

Genetic-algorithm engine for LLM prompt optimization. Evaluates candidate
prompts against a test set across multiple LLM providers (OpenAI, Anthropic,
Gemini, OpenRouter, Groq), evolves them with mutation/crossover/meta-prompting
operators, and scores fitness on quality, safety, cost, latency, and stability.

This is the embeddable engine. Most users want:
- `@promptengine/cli` — command-line runner (`npx promptengine`)
- PromptEngine.AI desktop app — visual evolution graph

## Programmatic use

The host injects platform services before starting an evaluation:

```ts
import { setStore, setSendUpdate, initializeDatabase, startEvaluation } from '@promptengine/core';
```

See the repository for full documentation.
```

`packages/cli/README.md`:

```markdown
# @promptengine/cli

Command-line runner for PromptEngine.AI prompt evolution — designed for CI,
scripts, and AI agents.

## Usage

```bash
promptengine --config evolution.json      # run an evolution
promptengine --sync-models                # sync models from OpenRouter
promptengine --list-models                # list models with pricing
promptengine --set-key openai sk-...      # save an API key
promptengine --help
```

Progress goes to stderr; the JSON result goes to stdout (pipe-friendly).
See `docs/cli.md` in the repository for the full config reference.
```

- [ ] **Step 3: Optional `repository` field** — run `git remote -v`; if a remote exists, add to both package.jsons: `"repository": { "type": "git", "url": "<remote url>" }`. If no remote, skip (do not invent one).

- [ ] **Step 4: Build both packages and pack-check**

```bash
npm run build:packages
node packages/cli/dist/index.js --help          # bin runs from dist against built core
cd packages/core && npm pack --dry-run && cd ../..
cd packages/cli && npm pack --dry-run && cd ../..
```

Expected: builds succeed with `dist/index.js` (+ `index.d.ts` for core); each dry-run lists ONLY `package.json`, `README.md`, `LICENSE`, and `dist/*` files.

- [ ] **Step 5: Install-from-tarball smoke test** (proves an agent machine with plain Node can use it — including sql.js WASM resolution from node_modules):

```bash
SCRATCH="$(mktemp -d)" && cd packages/core && npm pack --pack-destination "$SCRATCH" && cd ../cli && npm pack --pack-destination "$SCRATCH" && cd ../..
cd "$SCRATCH" && npm init -y && npm install ./promptengine-core-1.0.0.tgz ./promptengine-cli-1.0.0.tgz
npx promptengine --help
npx promptengine --list-models --db ./smoke.db
cd - && rm -rf "$SCRATCH"
```

Expected: `--help` prints usage (exit 0); `--list-models` initializes a fresh sql.js database at `./smoke.db` and prints an empty/`no models` listing without any WASM or module-resolution error. (Actual npm tarball filenames are `promptengine-core-1.0.0.tgz` / `promptengine-cli-1.0.0.tgz` — scoped names flatten with a dash; adjust if npm names them differently, e.g. check `ls "$SCRATCH"`.)

- [ ] **Step 6: One full desktop installer build** (the electron-builder + workspaces risk called out in the spec):

```bash
npm run build -w apps/desktop
```

Expected: `apps/desktop/release/` contains the NSIS installer and `PromptEngine-1.0.0-portable.exe`. If electron-builder fails resolving hoisted modules, the known fix is adding `"npmRebuild": false` to the `build` block — apply only if needed. Launch the portable exe once; verify the window opens and the evaluation list loads (sql.js + userData path intact), then close it.

- [ ] **Step 7: Update `CLAUDE.md`** — rewrite the Commands section (root scripts unchanged in name; note `build:packages`), the Architecture section paths (`electron/engine/` → `packages/core/src/engine/`, `electron/providers/` → `packages/core/src/providers/`, `electron/database/` → `packages/core/src/database/`, `electron/ipc/handlers.ts` → `apps/desktop/electron/ipc/handlers.ts`, tests per package), and add a short "Workspace layout" block mirroring the spec's tree. Update `docs/cli.md` with an "Install" note: from this repo `npm run cli -- ...`; as a package `npx promptengine ...` (not yet published).

- [ ] **Step 8: Final full verification**

```bash
npx vitest run && npm run type-check && npm run cli -- --help
```

Expected: everything green.

- [ ] **Step 9: Commit**

```bash
git add LICENSE packages/core/README.md packages/core/LICENSE packages/core/package.json packages/cli/README.md packages/cli/LICENSE packages/cli/package.json CLAUDE.md docs/cli.md
git commit -m "Add publish metadata, package READMEs, LICENSE; verify pack + tarball install"
```
