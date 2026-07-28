# Plugin System for Operators and Providers (Phase 5)

**Date**: 2026-07-28
**Status**: Approved design, pending implementation plan

## Goal

Community contributors add genetic operators and LLM providers without touching core. Plugins are single JS module files loaded from known directories, they work in BOTH hosts (Electron desktop and plain-Node CLI), and the five built-in operators are converted to registry entries using the same interface — one dispatch mechanism, not two.

Decisions locked during brainstorming:
1. **Format**: file-based JS modules (`.mjs`/`.js` file or folder with `index.js`) in plugin directories — no npm-package discovery in this phase.
2. **Unification**: built-ins go through the same operator registry as plugins; the 5-way switch in `generation.ts` is replaced by registry dispatch.
3. **UI scope**: dynamic plugin-operator sliders in NewEvaluationModal + a minimal Settings panel (list, enable/disable with restart-to-apply, open-folder). No per-plugin config forms, no hot reload, no in-app install.

## Plugin author contract

A plugin module default-exports:

```js
export default {
  name: 'my-extras',        // plugin id: listing + enable/disable; required, unique
  version: '1.0.0',         // optional, shown in UI
  operators: [ /* OperatorPlugin[] */ ],   // optional
  providers: [ /* ProviderPlugin[] */ ],   // optional
};
```

One module may contribute operators, providers, or both. TypeScript authors precompile; hosts never compile TS. Two working examples ship in `examples/plugins/`:
- `section-shuffle.mjs` — deterministic, LLM-free operator (also the canonical test-fixture pattern)
- `ollama/` — provider adapter for a local Ollama server (OpenAI-compatible endpoint, zero-cost model entries), unit-tested with mocked fetch

## New core types (`packages/core/src/types.ts`)

```ts
export interface OperatorContext {
  parent: CandidateNode;
  parentB?: CandidateNode;          // present when parents === 2
  config: EvaluationConfig;
  generation: CandidateNode[];      // current generation snapshot
}

export interface OperatorResult {
  prompt: string;
  params?: Partial<CandidateParams>;  // optional patch (temperature, seed, model)
  changeLog: ChangeLogLine[];
  cost: { promptTokens: number; completionTokens: number; usd: number; calls: number };
}

export interface OperatorPlugin {
  name: string;                     // unique id: config share key, changelog source, effectiveness key
  label?: string;                   // display name (UI)
  description?: string;
  parents: 1 | 2;                   // unary (mutation-like) or binary (crossover-like)
  apply(ctx: OperatorContext): Promise<OperatorResult>;
}

export interface ProviderPlugin {
  adapter: ProviderAdapter;         // adapter.name is the provider id
  models?: ModelCostEntry[];        // upserted into model_costs at registration
}

export interface PluginManifest {
  name: string;
  version?: string;
  source: string;                   // absolute path of the loaded module
  operators: string[];              // operator names contributed
  providers: string[];              // provider ids contributed
  error?: string;                   // set when the module failed to load/validate
}
```

**Opened unions** (autocomplete preserved, plugin ids legal):
- `Provider` → `'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | (string & {})`
- `ChangeLabel` → existing literals `| (string & {})`

## Registries (`packages/core/src/registry.ts`, new)

- `registerOperator(op: OperatorPlugin): void` — throws on duplicate name (including the built-in names).
- `registerProvider(plugin: ProviderPlugin): void` — throws on duplicate provider id; when `models` present and a database is initialized, upserts them into `model_costs` (INSERT OR REPLACE); when the database is not yet initialized, entries are queued and flushed by `initializeDatabase`.
- `listOperators(): OperatorPlugin[]`, `listProviders(): string[]`, `getOperator(name)`, `resetRegistry()` (test helper, clears to built-ins only).
- `getProviderAdapter(provider)` in `providers/index.ts`: built-in map first, then registry, then `throw new Error('Unknown provider: …')` (today it returns `undefined` and fails later — tightening this is in scope).
- Exported from the core index: all of the above plus `loadPlugins` and the new types.

## Built-ins as registry entries

Five thin wrappers pre-registered at module init (in `registry.ts`, importing the existing operator functions — the operator modules themselves are unchanged):

| Name | parents | Wraps | Result mapping |
|---|---|---|---|
| `mutation` | 1 | `mutateNode(parent.prompt, config)` | as returned |
| `crossover` | 2 | `crossoverNodes(parent, parentB, config)` | as returned |
| `meta` | 1 | `metaPromptNode(parent, config, generation)` | as returned |
| `param` | 1 | `varyParameters(...)` | `prompt` = parent prompt, `params` = temperature/seed patch, cost zero |
| `model` | 1 | `varyModel(...)` | `prompt` = parent prompt, `params.model` patch, cost zero; may signal "no variation possible" → dispatcher falls back to carry |

## Dispatch generalization (`packages/core/src/engine/generation.ts`)

`createNextGeneration` replaces the hardcoded share collection + switch with:

1. **Shares map**: `{ mutation: operators.mutationShare, crossover: operators.crossoverShare, meta: metaPrompting.enabled ? share : 0, param: …, model: … }` merged with `config.operators.custom` (each `{ enabled?: boolean; share: number }`, keyed by operator name; `enabled === false` → share 0). Custom keys with no registered operator log a warning and are dropped. Custom keys MAY also reference built-in names (overriding the legacy field) — last-write-wins with `custom` taking precedence.
2. **Normalization**: unchanged largest-remainder method over the merged map.
3. **Dispatch loop**: for each child slot, pick the operator by normalized share, build `OperatorContext` (binary operators get `parentB` chosen exactly as crossover does today; a binary operator with only one distinct parent available falls back to carry), `await plugin.apply(ctx)`.
4. **Result handling**: new node prompt/params from `OperatorResult` (params patch merged over parent params), changelog appended, cost accumulated into run totals exactly as today, `_operatorType` = plugin name.
5. **Failure**: `apply()` throws → carry-forward node (parent prompt, `ERROR` changelog line) — identical to current behavior.
6. **Effectiveness**: `operatorEffectiveness` in `evaluator_v2.ts` becomes `Record<string, { totalDelta: number; count: number }>` with lazy key initialization (`elite` included as today).

## Plugin loader (`packages/core/src/pluginLoader.ts`, new)

`loadPlugins(opts: { dirs?: string[]; paths?: string[]; disabled?: string[] }): Promise<PluginManifest[]>`

- Discovery per dir: entries matching `*.mjs`, `*.js`, or subdirectories containing `index.js`/`index.mjs`. Explicit `paths` load directly. Missing dirs are silently skipped.
- Load: `await import(pathToFileURL(file).href)`; validate: default export is an object with a string `name`, and `operators`/`providers` arrays (when present) contain entries with the required fields (operator: `name`, `parents` 1|2, `apply` function; provider: `adapter` with string `name` and `call` function).
- Modules whose `name` is in `disabled` are skipped with a manifest entry (no error, `operators`/`providers` empty).
- Any load/validation/registration error (including duplicate names) → manifest `error` string; the module contributes nothing; loading continues with the next module. `loadPlugins` never throws for per-module failures.

## Hosts

### Config (`EvaluationConfig`)
- New optional field: `operators.custom?: Record<string, { enabled?: boolean; share: number }>`.
- Legacy five operator fields unchanged — existing saved configs and the desktop modal keep working with zero migration.

### CLI (`packages/cli`)
- Config JSON gains `"plugins": string[]` — file or directory paths, resolved relative to the config file's directory.
- New flag `--plugins <dir>` (repeatable) merged with config paths.
- Plugins load after the store shim is installed and before the database/evolution starts; manifests with errors print to stderr (run continues; a plugin referenced by `operators.custom` but failed → the existing unknown-key warning applies).
- Key resolution for plugin providers: `ENV_VAR_MAP[provider] ?? \`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY\``; `--set-key` accepts any provider id (validation list becomes advisory: known providers validated strictly, unknown ids accepted with a notice).
- `docs/cli.md` documents the `plugins` field, the flag, and the author contract.

### Desktop (`apps/desktop`)
- `main.ts` startup (after store injection, before `registerIPCHandlers`): `loadPlugins({ dirs: [path.join(app.getPath('userData'), 'plugins')], disabled: store.get('disabledPlugins', []) })`; manifests kept in module state.
- New IPC handlers: `plugins:list` → `{ manifests, disabled: string[] }`; `plugins:setEnabled` (name, enabled) → updates `disabledPlugins` in the store (applies on restart); `plugins:openFolder` → `shell.openPath` on the plugins dir (creating it first).
- Preload exposes `window.electronAPI.plugins.{list, setEnabled, openFolder}`.

## UI

- **Settings → Plugins section**: table of manifests (name, version, contributes "2 operators, 1 provider", source filename); toggle per plugin bound to `plugins:setEnabled` with a "restart to apply" hint; error rows shown in red with the error string; "Open plugins folder" button. Empty state: short explainer + open-folder button.
- **NewEvaluationModal**: below the existing five operator controls, a "Plugin operators" group appears when `plugins:list` reports any operator contributions: one share input per plugin operator (label + description tooltip), writing `{ enabled: true, share }` into `operators.custom`. Absent plugins ⇒ group hidden; nothing else in the modal changes.
- **Graph tolerance**: node changelog label rendering falls back to a default style for labels outside the built-in set.

## Trust model

Plugins are arbitrary local JavaScript executed with full process privileges — the same trust level as installing an npm dependency. No sandboxing. Stated plainly in `docs/plugins.md` (new author guide) and the Settings panel explainer.

## Out of scope (this phase)

- npm-package plugin discovery; per-plugin configuration UI/schemas; hot reload; in-app plugin install/removal; sandboxing; plugin-contributed fitness dimensions, selection policies, or test grading modes.

## Testing

- **Registry**: register/list/duplicate-throw; provider fallback order; model upsert on registration (and queued flush through `initializeDatabase`); `resetRegistry` isolation between tests.
- **Loader**: fixture modules under `packages/core/tests/fixtures/plugins/` — valid operator plugin, valid provider plugin, combined, broken (throws at import), invalid shape, duplicate name, disabled entry; manifests assert error capture and non-propagation.
- **Dispatch**: registered fake operator receives shares and context (incl. binary parentB), result mapping (params patch, changelog, cost accumulation), throw → carry with ERROR label, `operators.custom` precedence over legacy fields, unknown custom key warning, effectiveness records under plugin name.
- **CLI**: config with `plugins` paths loads fixtures relative to config dir; `--plugins` flag; plugin-provider env key resolution.
- **Desktop**: `plugins:list` / `plugins:setEnabled` handler tests (mock store, fixture manifests); preload surface presence.
- **Examples**: `examples/plugins/*` imported and unit-tested (shuffle determinism; Ollama adapter request/response parsing with mocked fetch).
- Definition of done: all existing 320 tests plus the new suites green; `npm run type-check` clean; desktop boots with an empty plugins dir; CLI runs a fixture-plugin evolution end-to-end in tests (mocked providers).
