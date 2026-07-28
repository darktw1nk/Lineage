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
import type { Provider } from '@promptengine/core';

// The engine logs via console.log/info/warn. Route ALL of it to stderr so
// stdout carries exactly one thing: the JSON result (pipe-friendly contract).
const toStderr = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

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
  console.log(`
PromptEngine.AI — CLI / Script Mode

USAGE:
  promptengine [OPTIONS]

OPTIONS:
  --config <path>              Run evolution from a JSON config file
  --output <path>              Write JSON results to file (default: stdout)
  --db <path>                  Use a specific database file
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
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
        result.config = args[++i];
        break;
      case '--output':
        result.output = args[++i];
        break;
      case '--db':
        result.db = args[++i];
        break;
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
          console.error(`Invalid provider: "${provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}`);
          process.exit(1);
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
  console.log(`Saved ${provider} key (${masked})`);
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

  console.log(`Synced ${models.length} models from OpenRouter`);

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();
}

async function handleListModels(dbPath?: string): Promise<void> {
  await initCliDatabase(dbPath);

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
    console.log('No models found. Run --sync-models to fetch from OpenRouter.');
    const { closeDatabase } = await import('@promptengine/core');
    closeDatabase();
    return;
  }

  console.log(`\n${'Provider'.padEnd(12)} ${'Model'.padEnd(45)} ${'Prompt/1k'.padEnd(12)} Completion/1k`);
  console.log('-'.repeat(85));

  for (const row of rows) {
    console.log(
      `${row.provider.padEnd(12)} ${row.model.padEnd(45)} $${row.prompt_usd_per_1k.toFixed(6).padEnd(11)} $${row.completion_usd_per_1k.toFixed(6)}`
    );
  }

  console.log(`\nTotal: ${rows.length} models`);

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();
}

async function handleRunEvolution(configPath: string, outputPath?: string, dbPath?: string): Promise<void> {
  // Load and validate config
  const cliConfig = loadCliConfig(configPath);
  const configKeys = extractConfigKeys(cliConfig);

  // Install store shim before any provider imports
  installStoreShim(configKeys, cliConfig.systemPrompts);

  // Initialize database
  await initCliDatabase(dbPath);

  // Verify we have API keys for all required providers
  const configDir = (await import('path')).dirname((await import('path')).resolve(configPath));
  const evalConfig = toEvaluationConfig(cliConfig, configDir);
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

  // Optionally write to output file
  if (outputPath) {
    const fs = await import('fs');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    process.stderr.write(`\nResults written to ${outputPath}\n`);
  }

  // Generate markdown report — next to the --output file when given,
  // otherwise under the current working directory.
  const { generateReport, slugify } = await import('./report.js');
  const fs = await import('fs');
  const path = await import('path');
  const reportDir = outputPath
    ? path.join(path.dirname(path.resolve(outputPath)), 'testoutputs')
    : path.resolve('testoutputs');
  fs.mkdirSync(reportDir, { recursive: true });
  const slug = slugify(cliConfig.name || evalConfig.name || 'evolution');
  const reportPath = path.join(reportDir, `output-${slug}.md`);
  fs.writeFileSync(reportPath, generateReport(result, evalConfig, cliConfig));
  process.stderr.write(`\nReport written to ${reportPath}\n`);

  const { closeDatabase } = await import('@promptengine/core');
  closeDatabase();

  // Agents rely on exit codes: no usable best prompt means the run failed.
  if (!result.best) {
    process.stderr.write(`\nEvolution produced no usable result${result.error ? `: ${result.error}` : ''}\n`);
    process.exitCode = 1;
  }
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

  if (args.config) {
    await handleRunEvolution(args.config, args.output, args.db);
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
