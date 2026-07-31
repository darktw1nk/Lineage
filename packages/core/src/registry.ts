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
import { withGlobalSemaphore, globalParallelLimit } from './engine/semaphore.js';
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
/**
 * Bound a plugin call by `callTimeoutMs`.
 *
 * docs/cli.md promises the option 'aborts any single LLM HTTP attempt after
 * that long — a hung request is retried with a fresh budget instead of stalling
 * a parallel slot forever'. Built-in adapters honour it via fetchWithTimeout,
 * but a plugin adapter is arbitrary code: the option is passed in and the
 * shipped Ollama example ignores it, so a hung local server stalled the run
 * indefinitely with a permit held.
 *
 * This cannot cancel the plugin's own work — nothing can — but it stops the
 * ENGINE waiting on it, which is what the promise is about.
 *
 * A timeout cannot cancel work. Two pure options are both wrong: holding the
 * permit keeps the cap exact but lets a dead provider wedge the run forever;
 * releasing it keeps the run alive but breaks the cap. So the permit is
 * released, the leak is COUNTED, and dispatch stops once leaks reach
 * parallelLimit — concurrency is bounded at 2x and the run always terminates.
 */
/**
 * Calls that timed out and whose work is still running, so their parallel slot
 * is unaccounted for. Decremented if the call ever does settle.
 */
let leakedCalls = 0;
/** How far concurrency may exceed parallelLimit before the run is stopped. */
function leakBudget(): number {
  return Math.max(1, globalParallelLimit());
}
/** Test hook: forget leaked calls between runs in the same process. */
export function resetLeakedCalls(): void {
  leakedCalls = 0;
}

function callWithTimeout<T>(
  start: () => Promise<T>, opts: { timeoutMs?: number }, name: string, label: string,
): Promise<T> {
  // setTimeout stores its delay in a 32-bit int: anything >= 2^31 wraps and
  // Node fires it after 1ms, so a 25-day timeout became an INSTANT one and
  // every call failed immediately. Clamp rather than reject — an absurd value
  // means 'effectively never', which is what the ceiling gives.
  const MAX_TIMER_MS = 2_147_483_647;
  const raw = opts?.timeoutMs;
  const ms = Number.isFinite(raw) && (raw as number) > MAX_TIMER_MS ? MAX_TIMER_MS : raw;
  if (!Number.isFinite(ms) || (ms as number) <= 0) {
    return withGlobalSemaphore(start, label);
  }

  let resolveOuter!: (value: T) => void;
  let rejectOuter!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolveOuter = res; rejectOuter = rej; });

  void withGlobalSemaphore(async () => {
    // Arm the timer HERE, not before the acquire. `callTimeoutMs` is documented
    // as a per-ATTEMPT abort; starting the clock outside made it measure queue
    // wait + call, so a call could be rejected while still queued, before
    // start() had ever run. Measured at parallelLimit 8 with 200 calls of 100ms
    // and callTimeoutMs 1500ms: 44% of callers failed although no single call
    // took over 100ms — and the queue only gets deeper as a provider slows, so
    // the failures cluster exactly when the run can least afford them.
    //
    // On timeout the permit is RELEASED (this callback returns) even though the
    // work is still running. Holding it instead — which is what the previous
    // version did — kept the concurrency cap exact but meant a provider that
    // never returns wedged the run permanently: measured at parallelLimit 4
    // with 10 callers, 4 errored and 6 were still pending at 1500ms, with no
    // error, no log, and no recovery, because shouldStop is never consulted
    // while awaiting a node's Promise.all, so neither timeLimitMs nor Stop
    // could end it.
    //
    // A timeout cannot cancel work, so both pure options are wrong: hold the
    // permit and risk the wedge, or release it and break the cap. Release, but
    // COUNT the leak — `leakedCalls` bounds how far the cap can be exceeded and
    // ends the run once the provider is clearly dead.
    // Refuse to START work once too many calls have leaked. This must happen
    // AFTER acquiring, not at dispatch: callers enqueue all at once, so a check
    // at entry is passed by every one of them before the first timeout fires.
    // Each leak is a slot's worth of concurrency we can no longer account for,
    // so stopping here bounds the overshoot at 2x parallelLimit and ends the run
    // with a diagnostic instead of letting it grow without limit.
    if (leakedCalls >= leakBudget()) {
      rejectOuter(new Error(
        `Provider '${name}' has ${leakedCalls} call(s) that never returned after callTimeoutMs. ` +
        `Refusing to start more — the provider is not responding and every further call would leak ` +
        `another parallel slot. Check the provider, or raise callTimeoutMs if it is merely slow.`,
      ));
      return;
    }

    let timedOut = false;
    // Releasing this resolves the semaphore callback and hands the permit on.
    let releasePermit!: () => void;
    const permitHeldUntil = new Promise<void>(r => { releasePermit = r; });

    const timer = setTimeout(() => {
      timedOut = true;
      leakedCalls++;
      console.warn(
        `[Registry] Provider '${name}' did not respond within ${ms}ms. Releasing its parallel slot so the ` +
        `run continues, but the call is still open — concurrency may exceed parallelLimit by ${leakedCalls} ` +
        `until it settles.`,
      );
      rejectOuter(new Error(
        `Provider '${name}' did not respond within callTimeoutMs (${ms}ms) — treating it as timed out`,
      ));
      releasePermit();
    }, ms as number);

    start().then(
      value => { if (timedOut) leakedCalls--; else resolveOuter(value); },
      error => { if (timedOut) leakedCalls--; else rejectOuter(error); },
    ).finally(() => { clearTimeout(timer); releasePermit(); });

    await permitHeldUntil;
  }, label).catch(() => { /* already routed to the caller above */ });

  return promise;
}

function throttleIfNeeded(adapter: ProviderAdapter): ProviderAdapter {
  // Kept as an optimisation, no longer as a correctness guard: withGlobalSemaphore
  // became re-entrant via AsyncLocalStorage, so double-wrapping a subclass no
  // longer self-deadlocks — it would just add a redundant Proxy layer. Verified
  // by the deadlock tests in plugin-throttle.test.ts, which stay green without it.
  if (adapter instanceof BaseProviderAdapter) return adapter;
  const inner = adapter.call.bind(adapter);
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'call') {
        return (opts: Parameters<ProviderAdapter['call']>[0]) =>
          callWithTimeout(() => inner(opts), opts, adapter.name, `${adapter.name}:${opts.model}`);
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
      async apply({ parent, config, rng, shouldAbort }) {
        const r = await mutateNode(parent.prompt, config, rng ?? Math.random, shouldAbort);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'crossover', label: 'Crossover', parents: 2,
      description: 'LLM merge of two parent prompts',
      async apply({ parent, parentB, config, shouldAbort }) {
        const r = await crossoverNodes(parent, parentB!, config, shouldAbort);
        return { prompt: r.prompt, changeLog: r.changeLog, cost: r.cost };
      },
    },
    {
      name: 'meta', label: 'Meta-prompting', parents: 1,
      description: 'Failure-aware surgical edits from test results',
      async apply({ parent, config, generation, shouldAbort }) {
        const r = await metaPromptNode(parent, config, generation, shouldAbort);
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
