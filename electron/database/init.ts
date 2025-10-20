import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export async function initializeDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'evolution.db');
  
  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Create tables
  createTables(db);
  
  // Run migrations if needed
  runMigrations(db);
}

function createTables(db: Database.Database): void {
  // Schema version
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);
  
  // Model costs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_costs (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_usd_per_1k REAL NOT NULL,
      completion_usd_per_1k REAL NOT NULL,
      PRIMARY KEY (provider, model)
    );
  `);
  
  // App settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  
  // Evaluation configs
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  
  // Evaluation runs
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      stop_reason TEXT,
      run_json TEXT NOT NULL,
      version TEXT NOT NULL,
      FOREIGN KEY (config_id) REFERENCES evaluation_configs(id)
    );
  `);
  
  // Candidate nodes (for querying)
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_nodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      fitness REAL,
      node_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES evaluation_runs(id)
    );
  `);
  
  // Cost ledger
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      usd REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES evaluation_runs(id)
    );
  `);
  
  // Raw response blobs
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_blobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      blob_data TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES evaluation_runs(id)
    );
  `);
  
  // Insert default model costs if table is empty
  // Check and run migrations first - this will handle model costs
  runMigrations(db);
}

function insertDefaultModelCosts(db: Database.Database): void {
  const defaults = [
    // OpenAI (prices per million tokens)
    { provider: 'openai', model: 'gpt-5', promptUSD: 1.25, completionUSD: 10.00 },
    { provider: 'openai', model: 'gpt-5-mini', promptUSD: 0.25, completionUSD: 2.00 },
    { provider: 'openai', model: 'gpt-5-nano', promptUSD: 0.05, completionUSD: 0.40 },
    { provider: 'openai', model: 'gpt-4.1', promptUSD: 2.00, completionUSD: 8.00 },
    { provider: 'openai', model: 'gpt-4.1-mini', promptUSD: 0.40, completionUSD: 1.60 },
    { provider: 'openai', model: 'gpt-4.1-nano', promptUSD: 0.10, completionUSD: 0.40 },
    { provider: 'openai', model: 'gpt-4o', promptUSD: 2.50, completionUSD: 10.00 },
    { provider: 'openai', model: 'gpt-4o-mini', promptUSD: 0.15, completionUSD: 0.60 },
    // Anthropic (prices per million tokens)
    { provider: 'anthropic', model: 'claude-opus', promptUSD: 15.00, completionUSD: 75.00 },
    { provider: 'anthropic', model: 'claude-sonnet-4.5', promptUSD: 3.00, completionUSD: 15.00 },
    { provider: 'anthropic', model: 'claude-haiku-4.5', promptUSD: 1.00, completionUSD: 5.00 },
    // Gemini (prices per million tokens)
    { provider: 'gemini', model: 'gemini-2.5-pro', promptUSD: 1.25, completionUSD: 10.00 },
    { provider: 'gemini', model: 'gemini-2.5-flash', promptUSD: 0.30, completionUSD: 2.50 },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite', promptUSD: 0.10, completionUSD: 0.40 },
    { provider: 'gemini', model: 'gemini-2.0-flash', promptUSD: 0.10, completionUSD: 0.40 },
    { provider: 'gemini', model: 'gemini-2.0-flash-lite', promptUSD: 0.075, completionUSD: 0.30 },
  ];
  
  const insert = db.prepare(`
    INSERT INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);
  
  // Note: Database still stores per 1k for backward compatibility, we divide by 1000
  for (const cost of defaults) {
    insert.run(cost.provider, cost.model, cost.promptUSD / 1000, cost.completionUSD / 1000);
  }
}

function runMigrations(db: Database.Database): void {
  // Check current schema version
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;
  
  if (currentVersion === 0) {
    // Initial setup - insert default models
    insertDefaultModelCosts(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  }
  
  // Migration 2: Update to new model list
  if (currentVersion < 2) {
    console.log('Running migration 2: Updating model costs to new models...');
    // Clear old models and insert new ones
    db.prepare('DELETE FROM model_costs').run();
    insertDefaultModelCosts(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    console.log('Migration 2 completed - new models loaded');
  }
}

