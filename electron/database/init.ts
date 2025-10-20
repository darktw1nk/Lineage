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
  const costCount = db.prepare('SELECT COUNT(*) as count FROM model_costs').get() as { count: number };
  if (costCount.count === 0) {
    insertDefaultModelCosts(db);
  }
}

function insertDefaultModelCosts(db: Database.Database): void {
  const defaults = [
    // OpenAI
    { provider: 'openai', model: 'gpt-4', promptUSD: 0.03, completionUSD: 0.06 },
    { provider: 'openai', model: 'gpt-4-turbo', promptUSD: 0.01, completionUSD: 0.03 },
    { provider: 'openai', model: 'gpt-3.5-turbo', promptUSD: 0.0005, completionUSD: 0.0015 },
    // Anthropic
    { provider: 'anthropic', model: 'claude-3-opus', promptUSD: 0.015, completionUSD: 0.075 },
    { provider: 'anthropic', model: 'claude-3-5-sonnet', promptUSD: 0.003, completionUSD: 0.015 },
    { provider: 'anthropic', model: 'claude-3-haiku', promptUSD: 0.00025, completionUSD: 0.00125 },
    // Gemini
    { provider: 'gemini', model: 'gemini-1.5-pro', promptUSD: 0.00125, completionUSD: 0.005 },
    { provider: 'gemini', model: 'gemini-1.5-flash', promptUSD: 0.000075, completionUSD: 0.0003 },
  ];
  
  const insert = db.prepare(`
    INSERT INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);
  
  for (const cost of defaults) {
    insert.run(cost.provider, cost.model, cost.promptUSD, cost.completionUSD);
  }
}

function runMigrations(db: Database.Database): void {
  // Check current schema version
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;
  
  // Add migrations here as needed
  // Example:
  // if (currentVersion < 1) {
  //   db.exec('ALTER TABLE ...');
  //   db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  // }
  
  if (currentVersion === 0) {
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  }
}

