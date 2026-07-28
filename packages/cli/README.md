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
