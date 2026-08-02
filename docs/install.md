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
npm run cli -- --init                                    # writes a runnable evolve.json
npm run cli -- --config evolve.json --db ./run.db --output results.json

# Sync the full OpenRouter model catalog (needs an OpenRouter key)
npm run cli -- --sync-models

npm run cli -- --help
```

Behavior contract:

- **stdout** carries exactly the JSON result for a `--config` run and for `--estimate`; all progress/logs go to **stderr**. (`--help` and `--list-models` print text to stdout; the other utility commands print only to stderr.)
- `--output <path>` also writes the JSON to a file; a human-readable markdown report lands in `testoutputs/` next to it
- **Exit code 0** ⇔ the run produced a usable best prompt; **1** otherwise
- `--db <path>` isolates the run in its own SQLite file; without it the CLI shares the desktop app's database (synced models and history appear in both)

Config file format: see [cli.md](cli.md) for the full field-by-field reference.

## Desktop app

```bash
npm run electron:dev     # dev mode: Vite HMR + Electron, port 5173
```

Build installers (output in `apps/desktop/release/`; electron-builder targets the OS you build on):

```bash
npm run build            # vite build + electron-builder
npm run build:strict     # type-check everything first, then build
```

### macOS / Linux

Everything above is cross-platform: the dependency tree is pure JavaScript (sql.js is WebAssembly — no native modules, no node-gyp), Electron's npm package downloads the right binaries for your OS, and the scripts avoid shell-specific syntax. On macOS or Linux the same three commands apply:

```bash
npm install              # pulls the macOS/Linux Electron binaries automatically
npm run electron:dev     # run the UI from source
npm run build            # build a local dmg/zip (macOS) or AppImage/deb (Linux)
```

Notes:

- A **locally built** macOS app runs without Gatekeeper warnings (quarantine only applies to downloaded binaries). Released binaries are unsigned — see [signing.md](signing.md) for the workaround and for how to enable signing.
- Icons ship for every platform: `build/icon.ico` carries seven frames (16-256) and `build/icons/` holds 16-1024. The 512 and 1024 macOS uses are upscales of the 256 master — no larger source exists.
- CI builds and tests on Windows, macOS and Linux on every push, and installers for all three are attached to each release. If something breaks, please open an issue with the command output.

## Installable packages

Both packages are on npm.

```bash
npm i -g @voxor/lineage-cli     # the `lineage` command; pulls the engine with it
lineage --help
```

`@voxor/lineage-core` is the engine on its own, for embedding it in your own tool. To install a
local build instead of the published one:

```bash
npm run build:packages
cd packages/core && npm pack && cd ../cli && npm pack
npm install /path/to/voxor-lineage-core-*.tgz /path/to/voxor-lineage-cli-*.tgz
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
- **Budget seems ignored** — cost accounting uses the model catalog, and an uncatalogued model ID is priced at **$0**, not at some default. Every call then costs nothing on paper, so `budget` can never trip. Check `--list-models`, and `--sync-models` to pull the OpenRouter catalog. The run warns about this at startup and `--estimate` flags it too.
- **Where is my data?** — the desktop app's database and stored keys live in the OS user-data dir (`%APPDATA%/evolution2/` on Windows in dev mode).
