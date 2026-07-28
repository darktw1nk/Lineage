# Installation & Running

## Prerequisites

- **Node.js ≥ 20** and npm
- API key for at least one provider: OpenAI, Anthropic, Google Gemini, Groq, or OpenRouter

```bash
git clone <this repo>
cd evolution2
npm install
```

The repo is an npm-workspaces monorepo — one `npm install` at the root sets up the engine (`packages/core`), the CLI (`packages/cli`), and the desktop app (`apps/desktop`).

## API keys

Three ways, in priority order:

1. **Environment variables** (recommended for CLI/CI/agents):
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`
2. **Config file**: `"geminiKey": "..."` (etc.) inside the evolution config JSON
3. **Stored keys**, shared between CLI and desktop app:
   ```bash
   npm run cli -- --set-key gemini <key>     # or: openai | anthropic | groq | openrouter
   ```
   The desktop app manages the same stored keys in **Settings**.

## CLI

```bash
# Discover catalogued models with pricing (budget enforcement needs catalogued models)
npm run cli -- --list-models --db ./run.db

# Run an evolution
npm run cli -- --config evolve.json --db ./run.db --output results.json

# Sync the full OpenRouter model catalog (needs an OpenRouter key)
npm run cli -- --sync-models

npm run cli -- --help
```

Behavior contract:

- **stdout** carries exactly the JSON result; all progress/logs go to **stderr**
- `--output <path>` also writes the JSON to a file; a human-readable markdown report lands in `testoutputs/` next to it
- **Exit code 0** ⇔ the run produced a usable best prompt; **1** otherwise
- `--db <path>` isolates the run in its own SQLite file; without it the CLI shares the desktop app's database (synced models and history appear in both)

Config file format: see [cli.md](cli.md) for the full field-by-field reference.

## Desktop app

```bash
npm run electron:dev     # dev mode: Vite HMR + Electron, port 5173
```

Build installers (Windows: NSIS setup + portable exe, output in `apps/desktop/release/`):

```bash
npm run build            # vite build + electron-builder
npm run build:strict     # type-check everything first, then build
```

## Installable packages

`@promptengine/core` (engine) and `@promptengine/cli` (the `promptengine` command) are publish-ready but not yet on npm. To use them outside this repo today:

```bash
npm run build:packages
cd packages/core && npm pack       # -> promptengine-core-1.0.0.tgz
cd ../cli && npm pack              # -> promptengine-cli-1.0.0.tgz

# in any project or empty directory:
npm install /path/to/promptengine-core-1.0.0.tgz /path/to/promptengine-cli-1.0.0.tgz
npx promptengine --help
```

Requires only plain Node — the engine uses sql.js (WebAssembly), so there are no native modules to compile.

## Development

```bash
npm test                 # all test suites (vitest workspace)
npm run test:watch
npm run type-check       # tsc across core, cli, and desktop
```

Run a single test file: `npx vitest run packages/core/tests/engine/fitness.test.ts`

## Troubleshooting

- **404 "model is no longer available"** — providers retire models; pick a current one from `--list-models` or re-sync via OpenRouter.
- **"No API key found for provider"** — the run needs a key for every provider referenced by `models` *and* `serviceModel`; see the key resolution order above.
- **Budget seems ignored** — cost accounting uses the model catalog; uncatalogued model IDs fall back to default pricing. Check `--list-models`.
- **Where is my data?** — the desktop app's database and stored keys live in the OS user-data dir (`%APPDATA%/evolution2/` on Windows in dev mode).
