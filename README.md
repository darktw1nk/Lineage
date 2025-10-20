# Prompt Evolution

A desktop application for evolving and optimizing LLM prompts using genetic algorithms.

## Features

- **Genetic Algorithm for Prompts**: Evolve prompts through mutations, crossovers, and meta-prompting
- **Multi-Provider Support**: OpenAI, Anthropic, and Google Gemini
- **Comprehensive Fitness Function**: Quality, safety, cost, latency, and stability metrics
- **Visual Timeline**: See generations evolve with node-based visualization
- **Test Sets**: LLM-graded or exact-match evaluation modes
- **Smart Caching**: Avoid redundant API calls
- **Budget Controls**: Set time, budget, and fitness targets
- **Export/Import**: Save and share evaluation runs

## Tech Stack

- **Electron** + **React** + **TypeScript**
- **Vite** for fast builds
- **Tailwind CSS** + **shadcn/ui** for UI
- **SQLite** for local storage
- **Zustand** for state management
- **React Query** for async state
- **D3.js** for visualizations

## Prerequisites

- Node.js 18+ and npm
- API keys for:
  - OpenAI (optional)
  - Anthropic (optional)
  - Google Gemini (optional)

## Installation

1. **Clone the repository**
   ```bash
   cd evolution2
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   ```bash
   npm run electron:dev
   ```

4. **Build for production**
   ```bash
   npm run electron:build
   ```

## Usage

### 1. Configure Settings

Click the **Settings** button in the left sidebar to:
- Add API keys for providers
- Set global parallel execution limit
- Configure per-model costs
- Set the service model for operations

### 2. Create New Evaluation

1. Click **New Evaluation**
2. Configure across 7 tabs:
   - **Main**: Name, mutation/crossover factors, selection policy
   - **Population**: Initial size, seed prompt, fill mode
   - **Models**: Select which models to use
   - **Test Set**: Define evaluation tests
   - **Fitness**: Configure weights for quality, safety, cost, latency, stability
   - **Targets**: Set stopping conditions (time/budget/fitness)
   - **Advanced**: Parallel limits, service model, raw capture

3. Click **Start Evaluation**

### 3. Monitor Progress

- **Center View**: Watch generations evolve in real-time
  - Top 3 nodes highlighted (Gold/Silver/Bronze)
  - Click nodes to see details
- **Footer**: Track tokens, spend, generation count, cache hits
- **Right Panel**: View prompt, tests, change log, metrics

### 4. Controls

- **Pause/Resume**: Pause and resume evaluations
- **Stop**: Stop evaluation manually
- Evaluations auto-stop when targets are reached

## Architecture

```
electron/
├── main.ts              # Electron main process
├── preload.ts           # IPC bridge
├── database/
│   └── init.ts         # SQLite setup
├── ipc/
│   └── handlers.ts     # IPC handlers
├── providers/
│   ├── openai.ts       # OpenAI adapter
│   ├── anthropic.ts    # Anthropic adapter
│   └── gemini.ts       # Gemini adapter
└── engine/
    ├── evaluator.ts    # Main evaluation engine
    ├── operators.ts    # Genetic operators
    └── fitness.ts      # Fitness calculation

src/
├── components/
│   ├── ui/             # shadcn/ui components
│   ├── LeftSidebar.tsx
│   ├── CenterView.tsx
│   ├── RightPanel.tsx
│   ├── Footer.tsx
│   ├── SettingsModal.tsx
│   └── NewEvaluationModal.tsx
├── types/
│   └── index.ts        # TypeScript types
└── utils/
    ├── distance.ts     # Levenshtein, JSON diff, numeric
    └── cn.ts           # Tailwind utilities
```

## Key Concepts

### Genetic Operators

1. **Mutation**: Small, targeted edits to improve prompts
   - Structure changes (reordering, formatting)
   - Content additions (examples, constraints)
   - Compression and regularization

2. **Crossover**: Combine best parts of two parent prompts
   - Section splicing
   - Ensemble distillation

3. **Meta-Prompting**: Targeted edits based on failure analysis
   - Analyzes worst-performing tests
   - Proposes surgical changes

4. **Parameter Variation**: Temperature adjustments within bounds

### Fitness Function

```
fitness = w_quality * quality 
        + w_safety * safety
        + w_cost * (1 - cost_norm)
        + w_latency * (1 - latency_norm)
        + w_stability * stability
```

Weights are auto-normalized to sum to 1.

### Selection

- **Top-K**: Select top K performers
- **Top-P**: Select top proportion P of candidates

### Caching

Results are cached based on:
- Prompt text
- Model + parameters
- Test set signature

Cache hits save API costs and time.

## Database Schema

- `evaluation_configs`: Saved configurations
- `evaluation_runs`: Run history with generations
- `candidate_nodes`: Individual prompt candidates
- `model_costs`: Per-model pricing
- `cost_ledger`: Spending tracking
- `raw_blobs`: Optional raw API responses

## Development

```bash
# Run development mode with hot reload
npm run electron:dev

# Type check
npm run type-check

# Build only (no packaging)
npm run build:dev
```

## Troubleshooting

### API Key Issues
- Keys are stored securely in OS keychain via keytar
- Test keys in Settings before starting evaluations

### Build Issues
- Clear `node_modules` and `dist-electron`
- Run `npm install` again
- Check Node.js version (18+)

### Database Issues
- Database is stored in OS user data folder
- Delete `evolution.db` to reset

## Roadmap

- [ ] D3 visualization of lineage graphs with edges
- [ ] Export/Import JSON functionality
- [ ] Rate limiting per provider
- [ ] Stability testing with multiple seeds
- [ ] Safety guardrails implementation
- [ ] CLI mode for headless execution
- [ ] Advanced analytics and charts
- [ ] Prompt diff visualization

## License

MIT

## Contributing

Contributions welcome! Please open issues and PRs.

