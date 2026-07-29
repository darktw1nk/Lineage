/**
 * Operator & provider registries. Built-in operators are pre-registered here
 * as thin wrappers around the existing operator modules; plugins add entries
 * via registerOperator/registerProvider (usually through the plugin loader).
 *
 * Import-cycle note: this module imports operator functions whose modules
 * import providers/index.js, which imports this module back. That is safe
 * because every cross-module reference happens at call time, never during
 * module initialization.
 */
import type { OperatorPlugin, ProviderPlugin, ProviderAdapter, ModelCostEntry } from './types.js';
import type { SqlJsWrapper } from './database/init.js';
import { mutateNode, crossoverNodes, metaPromptNode, varyParameters, varyModel } from './engine/operators_v2.js';
import { withGlobalSemaphore } from './engine/semaphore.js';
import { BaseProviderAdapter } from './providers/base.js';

/**
 * Put a plugin adapter behind the global concurrency semaphore.
 *
 * `withGlobalSemaphore` had exactly one call site — inside
 * `BaseProviderAdapter.call` — and plugin adapters are plain objects (that is
 * the shape docs/plugins.md documents and the shipped Ollama example uses), so
 * they bypassed it entirely. docs/cli.md calls `parallelLimit` "maximum
 * concurrent API calls"; measured peak for a plugin provider was
 * `parallelLimit x testSet.length` (32 at parallelLimit 8 with 4 tests), and
 * `samplesPerTest` multiplies it again. A modest 8/20/5 config would open 800
 * concurrent requests against a third-party API or a local server.
 *
 * Subclasses of BaseProviderAdapter already acquire it and must NOT be
 * double-wrapped: nested acquisition of a 1-permit semaphore self-deadlocks.
 */
function throttleIfNeeded(adapter: ProviderAdapter): ProviderAdapter {
  if (adapter instanceof BaseProviderAdapter) return adapter;
  const inner = adapter.call.bind(adapter);
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'call') {
        return (opts: Parameters<ProviderAdapter['call']>[0]) =>
          withGlobalSemaphore(() => inner(opts), `${adapter.name}:${opts.model}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const ZERO_COST = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 };
const BUILTIN_PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq'];
export const BUILTIN_OPERATOR_NAMES = ['mutation', 'crossover', 'meta', 'param', 'model'] as const;

const operators = new Map<string, OperatorPlugin>();
const providers = new Map<string, ProviderAdapter>();
let pendingModels: ModelCostEntry[] = [];

function builtinOperators(): OperatorPlugin[] {
  return [
    {
      name: 'mutation', label: 'Mutation', parents: 1,
      description: 'Strategy-guided LLM rewrite of the prompt',
      async apply({ parent, config, rng }) {
        const r = await mutateNode(parent.prompt, config, rng ?? Math.random);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'crossover', label: 'Crossover', parents: 2,
      description: 'LLM merge of two parent prompts',
      async apply({ parent, parentB, config }) {
        const r = await crossoverNodes(parent, parentB!, config);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'meta', label: 'Meta-prompting', parents: 1,
      description: 'Failure-aware surgical edits from test results',
      async apply({ parent, config, generation }) {
        const r = await metaPromptNode(parent, config, generation);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'param', label: 'Param variation', parents: 1,
      description: 'Temperature/seed variation, prompt unchanged',
      async apply({ parent, config, rng }) {
        const v = varyParameters(parent.params.temperature ?? 0.7, config, true, rng ?? Math.random);
        return { prompt: parent.prompt, params: { temperature: v.temperature }, changeLog: v.changeLog, cost: ZERO_COST };
      },
    },
    {
      name: 'model', label: 'Model variation', parents: 1,
      description: 'Same prompt on a different enabled model',
      async apply({ parent, config, rng }) {
        const v = varyModel(parent.params.model, config, true, config.enabledModels, rng ?? Math.random);
        if (v.changeLog.length === 0) {
          return {
            prompt: parent.prompt,
            changeLog: [{ label: 'CARRY', text: 'Model variation skipped (no other models available)' }],
            cost: ZERO_COST,
          };
        }
        return { prompt: parent.prompt, params: { model: v.model }, changeLog: v.changeLog, cost: ZERO_COST };
      },
    },
  ];
}

function registerBuiltins(): void {
  for (const op of builtinOperators()) operators.set(op.name, op);
}
registerBuiltins();

export function registerOperator(op: OperatorPlugin): void {
  if (operators.has(op.name)) {
    throw new Error(`Operator '${op.name}' is already registered`);
  }
  operators.set(op.name, op);
}

/**
 * Remove an operator. Used by the plugin loader to roll back a plugin whose
 * later entries failed to register, so a rejected plugin leaves nothing behind.
 */
export function unregisterOperator(name: string): void {
  operators.delete(name);
}

export function getOperator(name: string): OperatorPlugin | undefined {
  return operators.get(name);
}

export function listOperators(): OperatorPlugin[] {
  return [...operators.values()];
}

export function registerProvider(plugin: ProviderPlugin): void {
  const id = plugin.adapter.name;
  if (BUILTIN_PROVIDER_IDS.includes(id) || providers.has(id)) {
    throw new Error(`Provider '${id}' is already registered`);
  }
  // Validate declared model prices BEFORE accepting them: an undefined price
  // reaches a REAL NOT NULL column and makes sql.js throw out of
  // initializeDatabase — which, on the desktop, means the app never opens a
  // window and the user cannot reach Settings to disable the plugin.
  if (plugin.models?.length) {
    for (const m of plugin.models) {
      // Negative prices were accepted here: they produce negative spend, which
      // inverts fitness (a worse prompt scores higher) and lets totals.usd run
      // away from budgetUSD so the cap can never trip. Zero is legitimate — a
      // genuinely free local model.
      const bad =
        !m || typeof m.provider !== 'string' || typeof m.model !== 'string' ||
        !Number.isFinite(m.promptUSDper1k) || m.promptUSDper1k < 0 ||
        !Number.isFinite(m.completionUSDper1k) || m.completionUSDper1k < 0;
      if (bad) {
        throw new Error(
          `Provider '${id}' declares an invalid model entry ` +
          `(${JSON.stringify(m)}): provider/model must be strings and both prices finite numbers >= 0`
        );
      }
    }
  }

  providers.set(id, throttleIfNeeded(plugin.adapter));
  if (plugin.models?.length) {
    pendingModels.push(...plugin.models);
    tryFlushModels();
  }
}

/** Counterpart to unregisterOperator — see that comment. */
export function unregisterProvider(id: string): void {
  providers.delete(id);
}

export function getRegisteredProviderAdapter(id: string): ProviderAdapter | undefined {
  return providers.get(id);
}

export function listProviders(): string[] {
  return [...BUILTIN_PROVIDER_IDS, ...providers.keys()];
}

/** Upsert queued plugin model costs; safe to call when the db is unavailable. */
export function flushPendingPluginModels(db: SqlJsWrapper): void {
  if (pendingModels.length === 0) return;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);
  for (const m of pendingModels) {
    // Plugin entries are authored per-1k already (unlike the seeded defaults,
    // which are per-million and divided at insert) — pass through unchanged.
    // Per-row guard: one bad entry must not abort the whole flush (and with it
    // database initialization).
    try {
      insert.run(m.provider, m.model, m.promptUSDper1k, m.completionUSDper1k);
    } catch (error) {
      console.error(`[Registry] Skipping plugin model ${m?.provider}/${m?.model}:`, error);
    }
  }
  pendingModels = [];
}

function tryFlushModels(): void {
  // getDatabase throws before initializeDatabase — swallow and let
  // initializeDatabase flush the queue later.
  import('./database/init.js').then(({ getDatabase }) => {
    try { flushPendingPluginModels(getDatabase()); } catch { /* not initialized yet */ }
  }).catch(() => { /* ignore */ });
}

/** Test helper: clears plugin registrations, keeps built-ins. */
export function resetRegistry(): void {
  operators.clear();
  providers.clear();
  pendingModels = [];
  registerBuiltins();
}
