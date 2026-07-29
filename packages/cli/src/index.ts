#!/usr/bin/env node

/**
 * PromptEngine.AI — CLI / Script Mode
 *
 * Usage:
 *   promptengine --config <path>           Run evolution from config file
 *   promptengine --sync-models              Sync models from OpenRouter
 *   promptengine --list-models              List available models
 *   promptengine --set-key <provider> <key> Save API key
 *   promptengine --help                     Show help
 */

import { format } from 'node:util';
import { loadCliConfig, toEvaluationConfig, extractConfigKeys } from './config.js';
import { installStoreShim } from './engine.js';
import { resolveApiKey, saveApiKey } from './store.js';
import { initCliDatabase } from './database.js';
import type { Provider, EvaluationConfig } from '@promptengine/core';
import type { CliConfig } from './config.js';

// The engine logs via console.log/info/warn. Route ALL of it to stderr so
// stdout carries exactly one thing: the JSON result (pipe-friendly contract).
const toStderr = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

/**
 * Write a command's actual RESULT to stdout.
 *
 * Redirecting console.* above is about engine chatter, but it was applied
 * process-wide, so commands whose output IS the payload — `--list-models`,
 * `--sync-models`, `--set-key` — wrote zero bytes to stdout. An agent following
 * the documented "run --list-models first" step and capturing stdout saw
 * nothing at all.
 */
const emit = (line = '') => { process.stdout.write(line + '\n'); };

const VALID_PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq'];

// ---------------------------------------------------------------------------
// Signal handling & cleanup
// ---------------------------------------------------------------------------

let activeRunId: string | null = null;
let cleanupDone = false;

async function cleanup(signal: string): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;
  process.stderr.write(`\n${signal} received. Cleaning up...\n`);

  if (activeRunId) {
    try {
      const { stopEvaluation } = await import('@promptengine/core');
      stopEvaluation(activeRunId);
    } catch { /* best-effort */ }
  }

  try {
    const { closeDatabase } = await import('@promptengine/core');
    closeDatabase();
  } catch { /* best-effort */ }

  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => { cleanup('SIGINT'); });
process.on('SIGTERM', () => { cleanup('SIGTERM'); });
process.on('exit', () => {
  if (!cleanupDone) {
    try {
      // Synchronous import not possible here — rely on closeDatabase having been called
      // by the command handler. This is a last-resort guard.
    } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
  // Write directly: console.log is rerouted to stderr for engine logs, but
  // --help output belongs on stdout.
  process.stdout.write(`
PromptEngine.AI — CLI / Script Mode

USAGE:
  promptengine [OPTIONS]

OPTIONS:
  --config <path>              Run evolution from a JSON config file
  --output <path>              Write JSON results to file (default: stdout)
  --db <path>                  Use a specific database file
  --plugins <dir>              Load plugins from a directory (repeatable)
  --seed <n>                   Reproducibility seed (overrides config "seed")
  --resume <runId>             Resume an interrupted run from its checkpoint
  --report <path|none>         Markdown report destination, or 'none' to skip
  --estimate                   Print the cost estimate for --config and exit (no run)
  --sync-models                Sync available models from OpenRouter
  --list-models                List all models in the database with pricing
  --set-key <provider> <key>   Save an API key (shared with desktop app)
  --help                       Show this help message

PROVIDERS:
  openai, anthropic, gemini, openrouter, groq

ENVIRONMENT VARIABLES:
  OPENAI_API_KEY               OpenAI API key
  ANTHROPIC_API_KEY            Anthropic API key
  GEMINI_API_KEY               Google Gemini API key
  OPENROUTER_API_KEY           OpenRouter API key
  GROQ_API_KEY                 Groq API key

SYSTEM PROMPTS:
  Add a "systemPrompts" object to your config JSON to customize the LLM
  judge, mutation, crossover, and meta-prompting prompts. Available keys:
    llmGradingPrompt, safetyGuardrailPrompt, mutationStrategies,
    mutationProposalPrompt, mutationApplyPrompt, crossoverPrompt,
    metapromptWithFailuresPrompt, metapromptWithoutFailuresPrompt,
    metapromptApplyPrompt

EXAMPLES:
  # Run an evolution
  promptengine --config evolution.json

  # Save an API key (shared with desktop app)
  promptengine --set-key openrouter sk-or-v1-xxx

  # Sync OpenRouter models
  promptengine --sync-models

  # Pipe JSON output
  promptengine --config evolution.json 2>/dev/null > results.json
`);
}

function parseArgs(argv: string[]): {
  config?: string;
  output?: string;
  db?: string;
  syncModels: boolean;
  listModels: boolean;
  setKey?: { provider: Provider; key: string };
  help: boolean;
  pluginDirs: string[];
  seed?: number;
  resume?: string;
  report?: string;
  estimate: boolean;
} {
  const args = argv.slice(2);
  const result = {
    config: undefined as string | undefined,
    output: undefined as string | undefined,
    db: undefined as string | undefined,
    syncModels: false,
    listModels: false,
    setKey: undefined as { provider: Provider; key: string } | undefined,
    help: false,
    pluginDirs: [] as string[],
    seed: undefined as number | undefined,
    resume: undefined as string | undefined,
    report: undefined as string | undefined,
    estimate: false,
  };

  for (let i = 0; i < args.length; i++) {
    // A flag whose value is missing or empty must be an error, never a silent
    // default. `--db "$RUN_DB"` with an unset variable expanded to an empty
    // string and fell back to the SHARED DESKTOP DATABASE, writing a full run
    // into the user's real history.
    const requireValue = (flag: string): string => {
      const value = args[++i];
      if (value === undefined || value === '') {
        console.error(`${flag} requires a value`);
        process.exit(1);
      }
      return value;
    };

    switch (args[i]) {
      case '--config':
        result.config = requireValue('--config');
        break;
      case '--output':
        result.output = requireValue('--output');
        break;
      case '--db':
        result.db = requireValue('--db');
        break;
      case '--plugins':
        result.pluginDirs.push(requireValue('--plugins'));
        break;
      case '--resume':
        result.resume = args[++i];
        if (!result.resume) {
          console.error('--resume requires a run id');
          process.exit(1);
        }
        break;
      case '--report':
        result.report = args[++i];
        if (!result.report) {
          console.error("--report requires a path or 'none'");
          process.exit(1);
        }
        break;
      case '--estimate':
        result.estimate = true;
        break;
      case '--seed': {
        const raw = args[++i];
        // Full-string check: parseInt('12abc') === 12 would silently accept junk
        if (!raw || !/^-?\d+$/.test(raw)) {
          console.error('--seed requires an integer');
          process.exit(1);
        }
        result.seed = parseInt(raw, 10);
        break;
      }
      case '--sync-models':
        result.syncModels = true;
        break;
      case '--list-models':
        result.listModels = true;
        break;
      case '--set-key': {
        const provider = args[++i] as Provider;
        const key = args[++i];
        if (!VALID_PROVIDERS.includes(provider)) {
          console.error(`Note: "${provider}" is not a built-in provider (${VALID_PROVIDERS.join(', ')}) — saving the key anyway (plugin provider assumed).`);
        }
        if (!key) {
          console.error('Missing API key value for --set-key');
          process.exit(1);
        }
        result.setKey = { provider, key };
        break;
      }
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        console.error('Run with --help for usage information.');
        process.exit(1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSetKey(provider: Provider, key: string): Promise<void> {
  saveApiKey(provider, key);
  const masked = key.length > 4 ? '***' + key.slice(-4) : '****';
  emit(`Saved ${provider} key (${masked})`);
}

async function handleSyncModels(dbPath?: string): Promise<void> {
  // Initialize DB first
  await initCliDatabase(dbPath);

  // Resolve OpenRouter key
  const apiKey = resolveApiKey('openrouter');
  if (!apiKey) {
    console.error('No OpenRouter API key found.');
    console.error('Set via: --set-key openrouter <key>, or OPENROUTER_API_KEY env var');
    process.exit(1);
  }

  console.log('Fetching models from OpenRouter...');

  const { OpenRouterAdapter } = await import('@promptengine/core');
  const models = await OpenRouterAdapter.fetchModels(apiKey);

  // Upsert into database
  const { getDatabase } = await import('@promptengine/core');
  const db = getDatabase();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const m of models) {
      upsert.run('openrouter', m.id, m.promptUSDper1k, m.completionUSDper1k);
    }
  });
  insertMany();

  emit(`Synced ${models.length} models from OpenRouter`);

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();
}

async function handleListModels(dbPath?: string): Promise<void> {
  await initCliDatabase(dbPath, { readOnly: true });

  const { getDatabase } = await import('@promptengine/core');
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT provider, model, prompt_usd_per_1k, completion_usd_per_1k
    FROM model_costs
    ORDER BY provider, model
  `).all() as Array<{
    provider: string;
    model: string;
    prompt_usd_per_1k: number;
    completion_usd_per_1k: number;
  }>;

  if (rows.length === 0) {
    emit('No models found. Run --sync-models to fetch from OpenRouter.');
    const { closeDatabase } = await import('@promptengine/core');
    closeDatabase();
    return;
  }

  emit();
  emit(`${'Provider'.padEnd(12)} ${'Model'.padEnd(45)} ${'Prompt/1k'.padEnd(12)} Completion/1k`);
  emit('-'.repeat(85));

  for (const row of rows) {
    emit(
      `${row.provider.padEnd(12)} ${row.model.padEnd(45)} $${row.prompt_usd_per_1k.toFixed(6).padEnd(11)} $${row.completion_usd_per_1k.toFixed(6)}`
    );
  }

  emit();
  emit(`Total: ${rows.length} models`);

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();
}

async function handleRunEvolution(configPath: string, outputPath?: string, dbPath?: string, pluginDirs: string[] = [], seedOverride?: number, reportArg?: string): Promise<void> {
  // Load and validate config
  const cliConfig = loadCliConfig(configPath);
  const configKeys = extractConfigKeys(cliConfig);

  // Install store shim before any provider imports
  installStoreShim(configKeys, cliConfig.systemPrompts);

  // Load plugins (config-relative paths + --plugins dirs) BEFORE the database
  // opens so plugin provider model entries flush into model_costs.
  const pathMod = await import('path');
  const configDir = pathMod.dirname(pathMod.resolve(configPath));
  if ((cliConfig.plugins?.length ?? 0) > 0 || pluginDirs.length > 0) {
    const { loadCliPlugins } = await import('./plugins.js');
    await loadCliPlugins({ configDir, configPlugins: cliConfig.plugins ?? [], flagDirs: pluginDirs });
  }

  // Initialize database
  await initCliDatabase(dbPath);

  // Verify we have API keys for all required providers
  const evalConfig = toEvaluationConfig(cliConfig, configDir);
  if (seedOverride !== undefined) {
    evalConfig.seed = seedOverride;
  }
  const requiredProviders = new Set<Provider>();
  for (const model of evalConfig.enabledModels) {
    requiredProviders.add(model.provider);
  }
  requiredProviders.add(evalConfig.serviceModel.provider);

  for (const provider of requiredProviders) {
    const key = resolveApiKey(provider, configKeys);
    if (!key) {
      console.error(`No API key found for provider: ${provider}`);
      console.error(`Set via: --set-key ${provider} <key>, or ${provider.toUpperCase()}_API_KEY env var, or "${provider}Key" in config file`);
      process.exit(1);
    }
  }

  // Run the evolution
  const { runEvolution } = await import('./engine.js');
  const result = await runEvolution(evalConfig, {
    onRunId: (id) => { activeRunId = id; },
  });
  activeRunId = null;

  await emitOutputs(result, evalConfig, cliConfig, outputPath, reportArg);
}

/** Shared post-run tail: results file, markdown report, DB close, exit code. */
async function emitOutputs(
  result: import('./engine.js').EvolutionResult,
  evalConfig: EvaluationConfig,
  cliConfig: CliConfig | undefined,
  outputPath?: string,
  reportArg?: string,
): Promise<void> {
  // Optionally write to output file. A bad path must NOT change the exit code:
  // the run already completed and its JSON already reached stdout, so throwing
  // here turned a good, paid-for run into a CI failure — and skipped the report.
  if (outputPath) {
    try {
      const fsMod = await import('fs');
      fsMod.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      process.stderr.write(`\nResults written to ${outputPath}\n`);
    } catch (error) {
      process.stderr.write(`\nWarning: could not write results to ${outputPath}: ${error instanceof Error ? error.message : error}\n`);
    }
  }

  // Markdown report: --report none skips it; --report <path> writes exactly there;
  // default derives testoutputs/output-<slug>.md next to --output (or under cwd).
  if (reportArg?.toLowerCase() !== 'none') {
    const { generateReport, slugify } = await import('./report.js');
    const fs = await import('fs');
    const path = await import('path');
    let reportPath: string;
    if (reportArg) {
      reportPath = path.resolve(reportArg);
    } else {
      const reportDir = outputPath
        ? path.join(path.dirname(path.resolve(outputPath)), 'testoutputs')
        : path.resolve('testoutputs');
      const slug = slugify(cliConfig?.name || evalConfig.name || 'evolution');
      reportPath = path.join(reportDir, `output-${slug}.md`);
    }
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, generateReport(result, evalConfig, cliConfig));
      process.stderr.write(`\nReport written to ${reportPath}\n`);
    } catch (error: any) {
      // The report is auxiliary — a failed write must not change the run's exit code
      process.stderr.write(`\nReport write failed: ${error.message}\n`);
    }
  }

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();

  // Agents rely on exit codes: no usable best prompt means the run failed.
  if (!result.best) {
    process.stderr.write(`\nEvolution produced no usable result${result.error ? `: ${result.error}` : ''}\n`);
    process.exitCode = 1;
  }
}

async function handleEstimate(configPath: string, dbPath?: string, seedOverride?: number, pluginDirs: string[] = []): Promise<void> {
  const cliConfig = loadCliConfig(configPath);
  installStoreShim(extractConfigKeys(cliConfig), cliConfig.systemPrompts);
  await initCliDatabase(dbPath, { readOnly: true });
  const pathMod = await import('path');
  const configDir = pathMod.dirname(pathMod.resolve(configPath));
  // Plugin providers must be registered before validation, or estimating a
  // config that runs fine fails with 'Unknown provider "…"'.
  const { loadCliPlugins } = await import('./plugins.js');
  await loadCliPlugins({ configDir, configPlugins: cliConfig.plugins ?? [], flagDirs: pluginDirs });
  const evalConfig = toEvaluationConfig(cliConfig, configDir);
  if (seedOverride !== undefined) {
    // Keep the preview faithful: the seed influences the holdout partition
    evalConfig.seed = seedOverride;
  }
  const { estimateRunCost, getModelCost, closeDatabase } = await import('@promptengine/core');
  const est = await estimateRunCost(evalConfig, getModelCost);

  // Human breakdown to stderr, machine JSON to stdout (CLI contract)
  const scope = est.perGeneration ? ' per generation' : '';
  process.stderr.write(`Estimated cost${scope}: $${est.low.toFixed(4)} – $${est.high.toFixed(4)} (~${est.calls} calls)\n`);
  for (const b of est.breakdown) {
    process.stderr.write(`  ${b.label.padEnd(28)} ${String(b.calls).padStart(5)} calls  $${b.low.toFixed(4)} – $${b.high.toFixed(4)}\n`);
  }
  for (const w of est.warnings) process.stderr.write(`  note: ${w}\n`);
  // console.log is redirected to stderr in this CLI — write the JSON contract directly
  process.stdout.write(JSON.stringify(est, null, 2) + '\n');
  closeDatabase();
}

async function handleResumeRun(runId: string, configPath?: string, outputPath?: string, dbPath?: string, pluginDirs: string[] = [], reportArg?: string): Promise<void> {
  // Optional --config re-supplies file-based extras: keys, systemPrompts, plugins
  const cliConfig = configPath ? loadCliConfig(configPath) : undefined;
  const configKeys = cliConfig ? extractConfigKeys(cliConfig) : {};
  installStoreShim(configKeys, cliConfig?.systemPrompts);

  const pathMod = await import('path');
  if ((cliConfig?.plugins?.length ?? 0) > 0 || pluginDirs.length > 0) {
    const configDir = configPath ? pathMod.dirname(pathMod.resolve(configPath)) : process.cwd();
    const { loadCliPlugins } = await import('./plugins.js');
    await loadCliPlugins({ configDir, configPlugins: cliConfig?.plugins ?? [], flagDirs: pluginDirs });
  }

  await initCliDatabase(dbPath);
  const { getDatabase } = await import('@promptengine/core');
  const db = getDatabase();
  const row = db.prepare('SELECT run_json, config_id FROM evaluation_runs WHERE id = ?').get(runId) as { run_json: string; config_id: string } | undefined;
  if (!row) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  let run: any;
  try {
    run = JSON.parse(row.run_json);
  } catch {
    console.error(`Run ${runId} checkpoint is corrupt (unparseable run_json) — it cannot be resumed.`);
    process.exit(1);
  }
  if (run.status === 'finished') {
    console.error(`Run ${runId} is already finished — nothing to resume. Reseed a new run from its best prompt instead.`);
    process.exit(1);
  }
  const cfgRow = db.prepare('SELECT config_json FROM evaluation_configs WHERE id = ?').get(row.config_id) as { config_json: string } | undefined;
  if (!cfgRow) {
    console.error(`Config not found for run: ${row.config_id}`);
    process.exit(1);
  }
  let evalConfig: EvaluationConfig;
  try {
    evalConfig = JSON.parse(cfgRow.config_json);
  } catch {
    console.error(`Config for run ${runId} is corrupt (unparseable config_json).`);
    process.exit(1);
  }

  // Same key preflight as a fresh run
  const requiredProviders = new Set<Provider>();
  for (const model of evalConfig.enabledModels) {
    requiredProviders.add(model.provider);
  }
  requiredProviders.add(evalConfig.serviceModel.provider);

  // A checkpointed config can reference a provider that a PLUGIN registered.
  // Without --config (or --plugins) that plugin never loads, and the run does
  // not fail — it grinds through every remaining node with "Unknown provider",
  // marks itself finished, exits 0, and can never be resumed again. Refuse
  // before spending anything.
  const { listProviders } = await import('@promptengine/core');
  const available = new Set(listProviders());
  const missing = [...requiredProviders].filter(p => !available.has(p));
  if (missing.length > 0) {
    console.error(`Cannot resume ${runId}: provider(s) not registered: ${missing.join(', ')}`);
    console.error(
      missing.length === 1 && configPath === undefined
        ? 'That provider comes from a plugin. Re-run with --config <the original config> (or --plugins <dir>) so it loads.'
        : 'Pass --config <the original config> or --plugins <dir> so the plugin providers load.',
    );
    console.error('The run is untouched and can still be resumed once the provider is available.');
    process.exit(1);
  }

  for (const provider of requiredProviders) {
    const key = resolveApiKey(provider, configKeys);
    if (!key) {
      console.error(`No API key found for provider: ${provider}`);
      console.error(`Set via: --set-key ${provider} <key>, or ${provider.toUpperCase()}_API_KEY env var, or "${provider}Key" in config file`);
      process.exit(1);
    }
  }

  const { runEvolution } = await import('./engine.js');
  const result = await runEvolution(evalConfig, {
    existingRun: run,
    onRunId: (id) => { activeRunId = id; },
  });
  activeRunId = null;

  await emitOutputs(result, evalConfig, cliConfig, outputPath, reportArg);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || process.argv.length <= 2) {
    printHelp();
    process.exit(0);
  }

  if (args.setKey) {
    await handleSetKey(args.setKey.provider, args.setKey.key);
    return;
  }

  if (args.syncModels) {
    // Install store shim for OpenRouter key resolution
    installStoreShim();
    await handleSyncModels(args.db);
    return;
  }

  if (args.listModels) {
    await handleListModels(args.db);
    return;
  }

  if (args.estimate) {
    if (!args.config) {
      console.error('--estimate requires --config');
      process.exit(1);
    }
    if (args.output || args.report) {
      process.stderr.write('note: --estimate is a dry run — --output/--report are ignored\n');
    }
    if (args.resume) {
      process.stderr.write('note: --resume is ignored with --estimate (the estimate describes a fresh run of --config)\n');
    }
    await handleEstimate(args.config, args.db, args.seed, args.pluginDirs);
    return;
  }

  if (args.resume) {
    if (args.seed !== undefined) {
      process.stderr.write('note: --seed is ignored with --resume (the run keeps its original config)\n');
    }
    await handleResumeRun(args.resume, args.config, args.output, args.db, args.pluginDirs, args.report);
    return;
  }

  if (args.config) {
    await handleRunEvolution(args.config, args.output, args.db, args.pluginDirs, args.seed, args.report);
    return;
  }

  console.error('No action specified. Run with --help for usage.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message || err);
  // Best-effort cleanup on fatal error
  import('@promptengine/core')
    .then(({ closeDatabase }) => closeDatabase())
    .catch(() => {})
    .finally(() => process.exit(1));
});
