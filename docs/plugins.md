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
- API keys resolve from `<PROVIDER>_API_KEY` env vars (uppercased, dashes→underscores), `--set-key <provider> <key>`, or the desktop Settings.
- `models` entries appear in the desktop model pickers and give budget enforcement correct pricing.

## Failure behavior

- A module that throws at import time, fails validation, or collides with an existing operator/provider name is reported (manifest `error` in Settings; stderr in the CLI) and contributes nothing — the host keeps running.
- Duplicate names lose: the first registration wins, later ones error.

## Trust model

Plugins are arbitrary local JavaScript executed with full process privileges — exactly the trust level of an npm dependency. Only install plugins you trust. There is no sandbox.
