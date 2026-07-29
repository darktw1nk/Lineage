import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// SqlJsWrapper — drop-in replacement for better-sqlite3's API surface
// ---------------------------------------------------------------------------

class WrappedStatement {
  constructor(
    private _wrapper: SqlJsWrapper,
    private _sql: string,
  ) {}

  run(...params: unknown[]): { changes: number } {
    const flat = flattenParams(params);
    try {
      this._wrapper._db.run(this._sql, flat);
    } catch (err) {
      throwCompatError(err);
    }
    const changes = this._wrapper._db.getRowsModified();
    this._wrapper._scheduleSave();
    return { changes };
  }

  get(...params: unknown[]): unknown {
    const flat = flattenParams(params);
    let stmt;
    try {
      stmt = this._wrapper._db.prepare(this._sql);
      if (flat.length > 0) stmt.bind(flat);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } catch (err) {
      throwCompatError(err);
    } finally {
      stmt?.free();
    }
  }

  all(...params: unknown[]): unknown[] {
    const flat = flattenParams(params);
    let stmt;
    try {
      stmt = this._wrapper._db.prepare(this._sql);
      if (flat.length > 0) stmt.bind(flat);
      const rows: unknown[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } catch (err) {
      throwCompatError(err);
    } finally {
      stmt?.free();
    }
    return []; // unreachable, satisfies TS
  }
}

/** Flatten the variadic args callers pass, e.g. `.run(a, b, c)` → `[a, b, c]` */
function flattenParams(params: unknown[]): (string | number | Uint8Array | null)[] {
  if (params.length === 0) return [];
  // If first arg is already an array, use it directly
  if (Array.isArray(params[0])) return params[0];
  return params as (string | number | Uint8Array | null)[];
}

/** Convert sql.js errors to better-sqlite3–compatible error objects */
function throwCompatError(err: unknown): never {
  if (err instanceof Error) {
    if (err.message.includes('UNIQUE constraint')) {
      (err as Error & { code: string }).code = 'SQLITE_CONSTRAINT';
    }
  }
  throw err;
}

export class SqlJsWrapper {
  _db: SqlJsDatabase;
  private _dbPath: string;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: SqlJsDatabase, dbPath: string) {
    this._db = db;
    this._dbPath = dbPath;
  }

  exec(sql: string): void {
    this._db.run(sql);
    this._scheduleSave();
  }

  pragma(str: string): unknown {
    const results = this._db.exec(`PRAGMA ${str}`);
    if (results.length > 0 && results[0].values.length > 0) {
      return results[0].values[0][0];
    }
    return undefined;
  }

  prepare(sql: string): WrappedStatement {
    return new WrappedStatement(this, sql);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const wrapper = this;
    const wrapped = ((...args: unknown[]) => {
      wrapper._db.run('BEGIN');
      try {
        const result = fn(...args);
        wrapper._db.run('COMMIT');
        wrapper._flushSave();
        return result;
      } catch (err) {
        wrapper._db.run('ROLLBACK');
        throw err;
      }
    }) as unknown as T;
    return wrapped;
  }

  /** Schedule a debounced save (50ms) */
  _scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      // Runs on a timer: an unguarded throw here (ENOSPC, EPERM from AV/OneDrive
      // touching %APPDATA%) becomes an uncaught exception that kills the
      // Electron main process or a paid CLI run mid-flight.
      try {
        this._saveToDisk();
      } catch (error) {
        console.error('[Database] Scheduled save failed (will retry on next write):', error);
      }
    }, 50);
  }

  /** Flush any pending save immediately */
  _flushSave(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
  }

  /**
   * Atomic whole-file save: write a sibling temp file, fsync it, then rename
   * over the target. A plain writeFileSync truncates first, so a crash or disk
   * error mid-write leaves a torn (unopenable) or zero-byte database — and a
   * zero-byte file is silently treated as a fresh install, erasing all history.
   */
  private _saveToDisk(): void {
    const data = Buffer.from(this._db.export());
    const tmpPath = `${this._dbPath}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, data);
      fs.fsyncSync(fd); // durable before the rename makes it visible
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, this._dbPath); // atomic on both NTFS and POSIX
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closing down */ }
      }
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  close(): void {
    this._flushSave();
    this._db.close();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let db: SqlJsWrapper | null = null;
let lockPath: string | null = null;

export function getDatabase(): SqlJsWrapper {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

/**
 * Take an exclusive lock on the database file.
 *
 * Saves are whole-file writes of an in-memory snapshot taken at open, so two
 * processes on one file silently erase each other's committed work — and the
 * CLI defaults to the desktop's database, making that the NORMAL case rather
 * than an exotic one. A stale lock (previous crash) is reclaimed by checking
 * whether the recorded pid is still alive.
 */
/** Total time we wait for a departing holder to release before giving up. */
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 150;

async function acquireDbLock(dbPath: string): Promise<void> {
  const lock = `${dbPath}.lock`;
  const readHolder = (): { pid: number; since: string } | null => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf-8'));
    } catch {
      return null;
    }
  };

  // Poll rather than fail on first contact. Handing the lock over is a normal,
  // brief event — `npm run electron:dev` restarts the main process on every
  // edit, and the replacement reliably starts before its predecessor has
  // finished quitting. Failing instantly turned that into a hard startup crash.
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lastReason = '';
  for (;;) {
    try {
      // 'wx' fails if the file already exists — atomic create-or-fail
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { flag: 'wx' });
      lockPath = lock;
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const holder = readHolder();
    if (!holder) {
      // Unreadable or 0 bytes. That is ALSO what a healthy lock looks like in
      // the instant between another process's create and its write, so treat it
      // as held rather than stealing it.
      lastReason = `${lock} exists but could not be read`;
    } else if (holder.pid === process.pid) {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      lockPath = lock;
      return;
    } else {
      // Only ESRCH ("no such process") proves the holder is gone. EPERM means
      // the process exists but belongs to another user or an elevated session —
      // reading that as "dead" stole live locks in exactly the case the lock
      // matters most.
      let alive = true;
      try {
        process.kill(holder.pid, 0); // signal 0 only tests existence
      } catch (error: any) {
        alive = error?.code !== 'ESRCH';
      }
      if (!alive) {
        console.warn(`[Database] Reclaiming stale lock from dead process ${holder.pid}`);
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
        lockPath = lock;
        return;
      }
      lastReason =
        `it is in use by process ${holder.pid} (since ${holder.since}). ` +
        `Two processes writing this file would erase each other's runs. ` +
        `Close the other instance, or pass a separate --db path`;
    }

    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
  }

  throw new Error(`Cannot open ${dbPath}: ${lastReason}. If that process is gone, delete ${lock}.`);
}

function releaseDbLock(): void {
  if (!lockPath) return;
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (holder?.pid === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Lock already gone or unreadable — nothing to release
  }
  lockPath = null;
}

export interface InitializeDatabaseOptions {
  /**
   * Open without taking the exclusive lock. For commands that only READ —
   * `--list-models`, `--estimate` — where locking out a user who happens to
   * have the desktop app open is pure obstruction: they never write.
   */
  readOnly?: boolean;
}

export async function initializeDatabase(dbPath: string, options: InitializeDatabaseOptions = {}): Promise<void> {
  if (!dbPath) {
    throw new Error('initializeDatabase requires a database file path');
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Exclusive access: whole-file saves make concurrent writers destructive
  if (!options.readOnly) {
    // A second init while one is already open would orphan the first lock file.
    releaseDbLock();
    await acquireDbLock(dbPath);
  }

  try {
    await openDatabase(dbPath);
  } catch (error) {
    // Anything after acquireDbLock that throws used to leave the lock behind,
    // permanently locking the user out of their own database.
    releaseDbLock();
    throw error;
  }
}

async function openDatabase(dbPath: string): Promise<void> {
  // Initialize sql.js WASM engine
  const SQL = await initSqlJs();

  // Load existing database file if present, otherwise create new
  let sqlDb: SqlJsDatabase;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    if (fileBuffer.length === 0) {
      // sql.js happily accepts an empty buffer as a brand-new database, and
      // migrations would then log "Fresh install" — silently discarding every
      // run the file used to hold. Refuse instead, and point at the recovery.
      const orphanTmp = `${dbPath}.tmp`;
      const hint = fs.existsSync(orphanTmp)
        ? ` A partial write exists at ${orphanTmp} — inspect it before deleting.`
        : '';
      throw new Error(
        `Database file at ${dbPath} is empty (0 bytes). Refusing to treat it as a fresh install, ` +
        `which would discard existing history. Restore it from backup, or delete the file to start clean.${hint}`
      );
    }
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new SqlJsWrapper(sqlDb, dbPath);
  db.pragma('journal_mode = WAL');

  // Create tables
  createTables(db);

  // Run migrations if needed
  runMigrations(db);

  // Plugin providers registered before the database opened queued their
  // model catalog entries — flush them now. (Dynamic import avoids a static
  // registry ↔ database cycle.)
  const { flushPendingPluginModels } = await import('../registry.js');
  flushPendingPluginModels(db);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  releaseDbLock();
}

function createTables(db: SqlJsWrapper): void {
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

function insertDefaultModelCosts(db: SqlJsWrapper): void {
  // Catalog refreshed 2026-07-28. Pricing sourced from OpenRouter's public
  // model list; Gemini model availability verified against the live
  // generateContent API (listed-but-retired models like gemini-2.0-flash
  // are excluded on purpose).
  const defaults = [
    // OpenAI (prices per million tokens)
    { provider: 'openai', model: 'gpt-5.4', promptUSD: 2.50, completionUSD: 15.00 },
    { provider: 'openai', model: 'gpt-5.4-mini', promptUSD: 0.75, completionUSD: 4.50 },
    { provider: 'openai', model: 'gpt-5.4-nano', promptUSD: 0.20, completionUSD: 1.25 },
    { provider: 'openai', model: 'gpt-5.1', promptUSD: 1.25, completionUSD: 10.00 },
    { provider: 'openai', model: 'gpt-5-mini', promptUSD: 0.25, completionUSD: 2.00 },
    { provider: 'openai', model: 'gpt-5-nano', promptUSD: 0.05, completionUSD: 0.40 },
    { provider: 'openai', model: 'gpt-4.1-mini', promptUSD: 0.40, completionUSD: 1.60 },
    { provider: 'openai', model: 'gpt-4.1-nano', promptUSD: 0.10, completionUSD: 0.40 },
    { provider: 'openai', model: 'gpt-4o-mini', promptUSD: 0.15, completionUSD: 0.60 },
    // Anthropic (prices per million tokens)
    { provider: 'anthropic', model: 'claude-opus-5', promptUSD: 5.00, completionUSD: 25.00 },
    { provider: 'anthropic', model: 'claude-sonnet-5', promptUSD: 2.00, completionUSD: 10.00 },
    { provider: 'anthropic', model: 'claude-sonnet-4.6', promptUSD: 3.00, completionUSD: 15.00 },
    { provider: 'anthropic', model: 'claude-haiku-4.5', promptUSD: 1.00, completionUSD: 5.00 },
    // Gemini (prices per million tokens; all verified callable 2026-07-28)
    { provider: 'gemini', model: 'gemini-3.6-flash', promptUSD: 1.50, completionUSD: 7.50 },
    { provider: 'gemini', model: 'gemini-3.5-flash', promptUSD: 1.50, completionUSD: 9.00 },
    { provider: 'gemini', model: 'gemini-3.5-flash-lite', promptUSD: 0.30, completionUSD: 2.50 },
    { provider: 'gemini', model: 'gemini-3.1-flash-lite', promptUSD: 0.25, completionUSD: 1.50 },
    { provider: 'gemini', model: 'gemini-2.5-pro', promptUSD: 1.25, completionUSD: 10.00 },
    { provider: 'gemini', model: 'gemini-2.5-flash', promptUSD: 0.30, completionUSD: 2.50 },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite', promptUSD: 0.10, completionUSD: 0.40 },
  ];

  // OR IGNORE: the fresh-install branch is inferred from a missing version row.
  // If that row is ever absent while model_costs is populated, a plain INSERT
  // trips the UNIQUE constraint and the database becomes permanently unopenable.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);

  // Database column is per_1k, defaults are per MILLION
  // To convert million → 1k: divide by 1000
  // Example: $0.05 per million = $0.00005 per 1k
  for (const cost of defaults) {
    insert.run(cost.provider, cost.model, cost.promptUSD / 1000, cost.completionUSD / 1000);
  }
}

function runMigrations(db: SqlJsWrapper): void {
  // Check current schema version
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion === 0) {
    // Fresh install - set up with latest schema (version 4) and models
    insertDefaultModelCosts(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (4)').run();
    console.log('Fresh install: Initialized with models (schema v4)');
    return; // No need to run migrations for fresh install
  }

  let version = currentVersion;

  // Legacy DBs accumulated one schema_version row per migration ([1],[2]);
  // a plain UPDATE would set them all to the same value and trip the UNIQUE
  // constraint. Always collapse to a single canonical row instead.
  const setVersion = (v: number): void => {
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
  };

  // Migration 2: Update existing users from old model list to new one
  if (version === 1) {
    console.log('Running migration 2: Updating model costs to new models...');
    // Clear old models and insert new ones
    db.prepare('DELETE FROM model_costs').run();
    insertDefaultModelCosts(db);
    setVersion(2);
    console.log('Migration 2 completed - new models loaded');
    version = 2;
  }

  // Migration 3: Refresh the direct-provider model catalog (2026-07 pricing;
  // removes retired models like gemini-2.0-flash). Preserves rows synced from
  // OpenRouter or added for other providers.
  if (version === 2) {
    console.log('Running migration 3: Refreshing default model catalog...');
    db.prepare("DELETE FROM model_costs WHERE provider IN ('openai', 'anthropic', 'gemini')").run();
    insertDefaultModelCosts(db);
    setVersion(3);
    console.log('Migration 3 completed - model catalog refreshed');
    version = 3;
  }

  // Migration 4: Drop the never-written cost_ledger table (cost accounting
  // now lives on run_json as costBreakdown)
  if (version === 3) {
    console.log('Running migration 4: Dropping legacy cost_ledger table...');
    db.exec('DROP TABLE IF EXISTS cost_ledger');
    setVersion(4);
    console.log('Migration 4 completed');
    version = 4;
  }

  // Future migrations go here
  // if (version === 4) { ... }
}
