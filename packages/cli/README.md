# @voxor/lineage-cli

Command-line runner for Lineage prompt evolution — designed for CI,
scripts, and AI agents.

## Usage

```bash
lineage --config evolution.json      # run an evolution
lineage --sync-models                # sync models from OpenRouter
lineage --list-models                # list models with pricing
lineage --set-key openai sk-...      # save an API key
lineage --help
```

Progress goes to stderr; the JSON result goes to stdout (pipe-friendly).
See `docs/cli.md` in the repository for the full config reference.
