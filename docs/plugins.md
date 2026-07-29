# Writing PromptEngine Plugins

A plugin is a single JavaScript module (`.mjs`/`.js` file, or a folder with `index.mjs`) that default-exports:

```js
export default {
  name: 'my-plugin',          // required, unique
  version: '1.0.0',           // optional
  operators: [ /* ... */ ],   // optional
  providers: [ /* ... */ ],   // optional
};
```

Working examples: [`examples/plugins/`](../examples/plugins/).

## Where plugins load from

- **Desktop app**: the `plugins/` folder inside the app's user-data directory (Settings → Plugins → "Open plugins folder"). Enable/disable per plugin in Settings; changes apply on restart.
- **CLI**: `"plugins": ["./my-plugin.mjs"]` in the config JSON (paths relative to the config file) or `--plugins <dir>`.

Plugins are authored in plain JavaScript (ESM). TypeScript authors precompile — hosts never compile TS.

## Operators

```js
{
  name: 'section-shuffle',       // unique id: used in config shares, changelogs, effectiveness stats
  label: 'Section Shuffle',      // UI display name
  description: '...',
  parents: 1,                    // 1 = unary (gets `parent`), 2 = binary (also gets `parentB`)
  async apply({ parent, parentB, config, generation, rng }) {
    return {
      prompt: '...',                                    // the child's prompt (required)
      params: { temperature: 1.2 },                     // optional patch: temperature, seed, model
      changeLog: [{ label: 'MY-LABEL', text: '...' }],  // shown in the lineage graph
      cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },  // report real LLM spend here
    };
  },
}
```

### The apply() contract

**Inputs are snapshots — `parent`, `parentB` and `generation` are deep copies.** Mutating them changes nothing; the engine keeps the originals. (Before this was enforced, a plugin that appended to `parent.prompt` rewrote the already-scored parent node in place and every sibling saw the damage.)

**The returned object is validated.** `prompt` must be a non-empty string. `changeLog` must be an array (non-object entries are dropped). `params` must be a plain object. `cost` fields must be finite numbers; anything else counts as 0. A result that fails validation is treated exactly like a thrown operator: the child carries the parent's prompt forward with an `ERROR` changelog entry, and the run continues.

**`apply()` is bounded by `callTimeoutMs`** (default 120000, settable in config). An operator that never resolves is rejected into the same carry-forward path rather than hanging the run.

**Report your real spend in `cost`.** It feeds run totals, the cost breakdown, and budget enforcement. If your operator throws *after* making paid calls, attach the spend to the error so it is still accounted:

```js
import { withPartialCost } from '@promptengine/core';
try { /* ... */ } catch (err) { throw withPartialCost(err, spentSoFar); }
```

**Binary operators get two different parents** where the population allows it; with a single surviving performer `parentB` may equal `parent`.

- Give users a share via `operators.custom` in the evaluation config: `{ "custom": { "section-shuffle": { "share": 0.3 } } }`. Shares are normalized together with the built-in operators. In the desktop app, plugin operators appear automatically in New Evaluation → Variations (Advanced mode).
- Need an LLM inside your operator? `import { getProviderAdapter } from '@promptengine/core'` and call the service model from `config.serviceModel` — report the spend in `cost` so budget enforcement stays accurate.
- Throwing from `apply()` is safe: the engine falls back to carrying the parent forward with an `ERROR` changelog entry.
- Need randomness? Use `ctx.rng()` instead of `Math.random()` — it's a deterministic stream when the run is seeded (`"seed"` / `--seed`), so your operator stays reproducible for free.

## Providers

```js
{
  adapter: {                       // implements the ProviderAdapter interface
    name: 'ollama',                // provider id: used in model refs ("ollama/llama3.2") and key lookup
    estimateTokens(input) { return { prompt: input.length / 4 }; },
    async call({ model, prompt, temperature, seed, maxTokens, providerOptions, images }) {
      return { output, promptTokens, completionTokens, latencyMs, usd };
    },
  },
  models: [                        // optional: seeds the model catalog (pricing per 1k tokens)
    { provider: 'ollama', model: 'llama3.2', promptUSDper1k: 0, completionUSDper1k: 0 },
  ],
}
```

- Prefer subclassing `BaseProviderAdapter` (exported from `@promptengine/core`) to inherit retry, concurrency-semaphore, and stored-key handling; implement `callAPI()` and `getApiKey()`. A plain object adapter (like the Ollama example) also works but bypasses those services.
- API keys resolve from `<PROVIDER>_API_KEY` env vars (uppercased, dashes→underscores), a `"<provider>Key"` field in the CLI config, `--set-key <provider> <key>`, or the desktop Settings.
- **`requiresApiKey: true`** — set this if your provider needs a key. Hosts refuse to start a run when a required key is missing, naming your provider and how to set it. Without it the run starts and every call fails against the real API, with retries and backoff, before reporting a generic failure. Omit it for a keyless provider (a local server like the Ollama example): defaulting to "required" is what used to make that example unusable.
- **`supportsSeed: false`** — set this if you accept `seed` in `call()` but do not forward it. The engine partitions its result cache by seed, so an adapter that silently drops it turns identical work into cache misses. Leave it unset if you do pass the seed through.
- `models` entries appear in the desktop model pickers and give budget enforcement correct pricing.

## Failure behavior

- A module that throws at import time, **hangs at import for more than 10 seconds**, fails validation, or collides with an existing operator/provider name is reported (manifest `error` in Settings; stderr in the CLI) and contributes nothing — the host keeps running.
- "Contributes nothing" is enforced by rollback: if a plugin's *second* operator fails to register, its first one is unregistered too. A plugin is all-or-nothing.
- Duplicate names lose: the first registration wins, later ones error. Two plugin *files* declaring the same plugin `name` is also an error — the Settings enable/disable toggle is keyed by name, so duplicates would toggle together.
- A misbehaving operator cannot take the run down: bad results, thrown errors and timeouts all degrade to carrying the parent prompt forward with an `ERROR` changelog entry.

**Known limitation:** the `disabled` list is keyed by plugin name, but a plugin's name is only known after its module is imported — so a disabled plugin's top-level code still executes. Keep import-time side effects out of plugin modules.

## Trust model

Plugins are arbitrary local JavaScript executed with full process privileges — exactly the trust level of an npm dependency. Only install plugins you trust. There is no sandbox.
