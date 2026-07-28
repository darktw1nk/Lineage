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
import {
  setStore,
  setSendUpdate,
  initializeDatabase,
  startEvaluation,
} from '@promptengine/core';
```

See the repository for full documentation.
