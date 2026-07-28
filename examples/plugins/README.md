# Example plugins

- `section-shuffle.mjs` — minimal LLM-free operator (deterministic section rotation)
- `ollama/` — provider adapter for a local Ollama server (free local models)

Try them:

```bash
# CLI: add to your evolution config
#   "plugins": ["../examples/plugins/section-shuffle.mjs"],
#   "operators": { "custom": { "section-shuffle": { "share": 0.3 } } }

# Desktop: copy into the app's plugins folder (Settings → Plugins → Open plugins folder)
```

Author guide: [docs/plugins.md](../../docs/plugins.md)
