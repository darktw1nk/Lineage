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

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const flat = flattenParams(params).map(coerceBindValue);
    try {
      this._wrapper._db.run(this._sql, flat as any);
    } catch (err) {
      throwCompatError(err);
    }
    const changes = this._wrapper._db.getRowsModified();
    // better-sqlite3 returns lastInsertRowid alongside changes. Omitting it
    // meant any caller reaching for it silently got undefined.
    let lastInsertRowid = 0;
    try {
      const row = this._wrapper._db.exec('SELECT last_insert_rowid() AS id');
      lastInsertRowid = Number(row?.[0]?.values?.[0]?.[0] ?? 0);
    } catch { /* not an INSERT, or no rowid table */ }
    this._wrapper._scheduleSave();
    return { changes, lastInsertRowid };
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
  // An array FIRST arg is the array form, `.run([a, b, c])`. It used to be
  // taken as the whole parameter list even when more args followed, so
  // `.run([a,b,c], d, e)` silently dropped d and e — no error, wrong row.
  if (Array.isArray(params[0])) {
    if (params.length > 1) {
      throw new Error(
        'Mixed parameter forms: pass either .run(a, b, c) or .run([a, b, c]), not an array followed by more arguments',
      );
    }
    return params[0];
  }
  return params as (string | number | Uint8Array | null)[];
}

/**
 * Normalise a bound value, or refuse it loudly.
 *
 * sql.js silently accepted several shapes that better-sqlite3 rejects, and
 * each stored something the reader could not recognise: `NaN` became NULL,
 * `Infinity` stored as a REAL that read back as `null`, a JS array bound as a
 * BLOB, and a BigInt past 2^53 degraded to a lossy REAL. Booleans are the one
 * exception worth allowing — 0/1 is the obvious intent and SQLite has no
 * boolean type — so they are converted rather than rejected.
 */
function coerceBindValue(value: unknown): string | number | Uint8Array | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`Cannot bind BigInt ${value}: outside the safe integer range, binding it would lose precision`);
    }
    return Number(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Cannot bind ${value}: SQLite has no representation for it (NaN would become NULL, Infinity reads back as null)`);
  }
  if (value instanceof Date) {
    throw new Error('Cannot bind a Date directly — store an ISO string or an epoch number');
  }
  if (Array.isArray(value)) {
    throw new Error('Cannot bind an array as a single value — it would be stored as a BLOB');
  }
  return value as string | number | Uint8Array | null;
}

/** Convert sql.js errors to better-sqlite3–compatible error objects */
function throwCompatError(err: unknown): never {
  // sql.js throws BARE STRINGS for bind failures ("Wrong API use : tried to
  // bind a value of an unknown type"). Every `instanceof Error` guard in the
  // codebase skipped those, and `.message` came back undefined — so the desktop
  // showed "Delete failed: undefined". Normalise to a real Error first.
  const error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
  if (error.message.includes('UNIQUE constraint')) {
    (error as Error & { code: string }).code = 'SQLITE_CONSTRAINT';
  }
  throw error;
}

/**
 * Rename, tolerating the transient sharing violations Windows produces.
 *
 * On Windows `rename` fails with EPERM/EBUSY/EACCES whenever ANY other process
 * holds the destination open, even for reading — Defender's real-time scan,
 * Search Indexer, OneDrive, a backup agent, or this project's own lock-free
 * `--list-models`. These windows are milliseconds, but a single failed attempt
 * was enough to silently drop a checkpoint. Spin briefly with Atomics.wait,
 * which is the only synchronous sleep available and this is a sync code path.
 */
function renameWithRetry(from: string, to: string, attempts = 10): void {
  const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error: any) {
      if (attempt >= attempts || !TRANSIENT.has(error?.code)) throw error;
      Atomics.wait(sleepBuffer, 0, 0, Math.min(100, 5 * attempt)); // 5,10,15… ms
    }
  }
}

export class SqlJsWrapper {
  _db: SqlJsDatabase;
  private _dbPath: string;

  /** Where this handle's file lives — sidecars are written alongside it. */
  get dbPath(): string { return this._dbPath; }

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _readOnly: boolean;
  private _consecutiveSaveFailures = 0;
  /** Duration of the last successful save, used to pace the next one. */
  private _lastSaveDurationMs = 5;
  /** Nesting depth, so an inner transaction uses a SAVEPOINT rather than BEGIN. */
  private _txDepth = 0;

  constructor(db: SqlJsDatabase, dbPath: string, readOnly = false) {
    this._db = db;
    this._dbPath = dbPath;
    this._readOnly = readOnly;
  }

  exec(sql: string): void {
    this._db.run(sql);
    this._scheduleSave();
  }

  /**
   * Write any pending changes to disk now, skipping the 50ms debounce.
   *
   * Call this after a write whose durability is the point — a run checkpoint
   * that --resume depends on. Ordinary writes should stay debounced; a save is
   * a whole-file write.
   *
   * RETURNS whether the data actually reached disk. It used to swallow the
   * error and return void, so persistRun reported success for checkpoints that
   * never landed: on Windows the atomic rename fails with EPERM whenever any
   * other process momentarily holds the file open (Defender, Search Indexer,
   * OneDrive, or this project's own lock-free `--list-models`), and a measured
   * 72% of checkpoints were lost that way. Losing the FINAL one makes a
   * completed run reappear as interrupted, so `--resume` pays for it twice.
   */
  flush(): boolean {
    try {
      this._flushSave();
      return true;
    } catch (error) {
      console.error('[Database] Flush failed — data is still in memory and a retry is scheduled:', error);
      this._scheduleSave(); // re-arm: a swallowed failure used to leave NOTHING pending
      return false;
    }
  }

  /**
   * Pragmas that live on the CONNECTION and must survive every export/reopen
   * cycle. Kept in one place so open and save cannot drift apart.
   */
  _applyConnectionPragmas(): void {
    try {
      this._db.exec('PRAGMA foreign_keys = ON');
    } catch { /* a pragma failure must never take down a save */ }
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
      let result: unknown;
      // Nested transactions use SAVEPOINTs, as better-sqlite3 does. A plain
      // BEGIN inside a transaction fails ("cannot start a transaction within a
      // transaction"), and the inner ROLLBACK then killed the OUTER one — so
      // the caller got an error naming neither problem and the outer
      // transaction's work vanished.
      const depth = wrapper._txDepth++;
      const savepoint = depth > 0 ? `pe_sp_${depth}` : null;
      wrapper._db.run(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      try {
        result = fn(...args);
        // An async callback would COMMIT the instant its promise was created,
        // before any of its work ran — a later throw then "rolled back" nothing
        // and every write persisted. better-sqlite3 refuses these outright;
        // so do we, rather than pretending to be transactional.
        if (result && typeof (result as any).then === 'function') {
          throw new Error(
            'transaction() callbacks must be synchronous — a promise-returning callback commits before its work runs. ' +
            'Do the async work first, then call transaction() with the synchronous writes.',
          );
        }
        wrapper._db.run(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      } catch (err) {
        try {
          // Roll back only OUR level. `ROLLBACK` unwinds everything, which is
          // how an inner failure used to destroy the outer transaction's work.
          wrapper._db.run(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch {
          // Already rolled back, or never began — keep the ORIGINAL error.
        }
        throw err;
      } finally {
        wrapper._txDepth = depth;
      }
      // Durability flush lives OUTSIDE the try: it runs after COMMIT, so a disk
      // error here used to land in the catch and issue a ROLLBACK against a
      // transaction that no longer existed — reporting "cannot rollback - no
      // transaction is active" and destroying the real ENOSPC/EPERM cause,
      // while the change stayed committed in memory with nothing scheduled to
      // save it. flush() re-arms the retry and reports rather than throwing.
      // Only the OUTERMOST commit is durable — an inner savepoint release has
      // not committed anything yet.
      if (depth === 0) wrapper.flush();
      return result;
    }) as unknown as T;
    return wrapped;
  }

  /**
   * How long to wait before the next save, based on how expensive saving has
   * become.
   *
   * Every save is a whole-file export, so its cost scales with the size of the
   * DATABASE — i.e. with accumulated history, not with the current run.
   * Measured: 13ms at 1.3MB, 43ms at 25MB, 80ms at 50MB. With a fixed 50ms
   * debounce that meant a large database spent most of its time exporting
   * itself, and a 72-node run wrote ~1.8GB.
   *
   * Scaling the gap to 10x the last save's duration caps the share of wall
   * time spent saving at roughly 10%, whatever the file size. A small database
   * keeps the original 50ms and behaves exactly as before.
   */
  private _adaptiveDelayMs(): number {
    return Math.max(50, Math.min(5000, Math.round(this._lastSaveDurationMs * 10)));
  }

  /** Schedule a debounced save, backing off while it keeps failing. */
  _scheduleSave(delayMs = this._adaptiveDelayMs()): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      // Runs on a timer: an unguarded throw here (ENOSPC, EPERM from AV/OneDrive
      // touching %APPDATA%) becomes an uncaught exception that kills the
      // Electron main process or a paid CLI run mid-flight.
      try {
        this._saveToDisk();
        this._consecutiveSaveFailures = 0;
      } catch (error) {
        // Re-arm with backoff. Clearing the timer and NOT rescheduling meant a
        // transient failure was simply dropped, and if no further write ever
        // came the data was gone.
        this._consecutiveSaveFailures++;
        const backoff = Math.min(2000, 50 * 2 ** Math.min(this._consecutiveSaveFailures, 5));
        console.error(
          `[Database] Scheduled save failed (attempt ${this._consecutiveSaveFailures}, retrying in ${backoff}ms):`,
          error,
        );
        this._scheduleSave(backoff);
      }
    }, delayMs);
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
    // A read-only handle takes NO lock, so it cannot know what another process
    // has committed since it opened. Every save is a whole-file export of the
    // snapshot taken at open — so writing here silently erased runs that a
    // lock-holding process had committed in the meantime. `--list-models` and
    // `--estimate` were rewriting the shared desktop database on every
    // invocation, destroying concurrent work.
    if (this._readOnly) return;

    const startedAt = Date.now();
    const data = Buffer.from(this._db.export());
    this._applyConnectionPragmas();
    // sql.js's export() CLOSES and REOPENS the underlying connection, which
    // resets every connection-scoped pragma. So `foreign_keys = ON`, set once at
    // open, was off again before the first checkpoint even landed — the declared
    // foreign keys were never actually enforced. Re-arm them on every export.
    const tmpPath = `${this._dbPath}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, data);
      fs.fsyncSync(fd); // durable before the rename makes it visible
      fs.closeSync(fd);
      fd = undefined;
      // Measure BEFORE the rename. renameWithRetry sleeps through transient
      // Windows EPERM/EBUSY (Defender, OneDrive), and folding those sleeps into
      // "save cost" made one transient hit inflate the adaptive debounce ~7x
      // (43ms -> 315ms, so 430ms -> 3150ms) for the rest of the session —
      // widening exactly the window in which a crash loses checkpoints. The
      // debounce is meant to track export cost, which scales with DB size; a
      // rename is O(1) and its retry sleeps are noise.
      this._lastSaveDurationMs = Date.now() - startedAt;
      renameWithRetry(tmpPath, this._dbPath); // atomic on both NTFS and POSIX
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closing down */ }
      }
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * @param save pass `{ save: false }` to DISCARD instead of persisting. Used
   * when an open is refused: that handle must never touch the file, because the
   * lock is about to be released and the whole point of the refusal was that
   * writing could destroy data.
   */
  close(opts: { save?: boolean } = {}): void {
    if (opts.save === false) {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      this._db.close();
      return;
    }
    // The final save must not prevent the handle from being released. An
    // unguarded _flushSave() here threw on quit (a locked file, a full disk),
    // escaped into Electron's before-quit sequence, and left the sql.js handle
    // and the lock file behind.
    if (!this.flush()) {
      console.error('[Database] Final save did not reach disk — the last changes are lost. Closing anyway.');
    }
    // Cancel the retry flush() just scheduled: nothing can service it now.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
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
      // A transient Windows sharing violation on the CREATE is not a reason to
      // kill the process. The retry beside this covers the RECLAIM path only,
      // while EPERM/EACCES/EBUSY here — delete-pending, Defender, the indexer —
      // was rethrown on the first attempt. Same failure mode the atomic save
      // already retries around; treat it as contention and wait it out.
      const TRANSIENT_CREATE = new Set(['EPERM', 'EACCES', 'EBUSY']);
      if (error?.code !== 'EEXIST' && !TRANSIENT_CREATE.has(error?.code)) throw error;
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
        // Reclaim by CLAIM-then-VERIFY.
        //
        // Two earlier designs were both wrong. A plain overwrite let two
        // processes that read the same dead pid both "win". Unlink-then-create
        // fixed that on POSIX but crashed on Windows: a concurrent unlink
        // leaves the file delete-pending, so unlink returns EPERM and the
        // following exclusive create returns EPERM rather than EEXIST — and
        // both rethrew straight out of initializeDatabase, killing the process
        // instead of politely waiting.
        //
        // Writing our pid and then re-reading it needs no unlink, so it cannot
        // hit that failure, and the loser of a simultaneous reclaim sees
        // someone else's pid and goes back to waiting.
        console.warn(`[Database] Reclaiming stale lock from dead process ${holder.pid}`);
        try {
          fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
        } catch (error: any) {
          // Another process is mid-reclaim. Treat it as held and keep waiting.
          lastReason = `${lock} could not be reclaimed (${error?.code ?? error})`;
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
          continue;
        }
        // Settle, then confirm the claim is still ours.
        await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
        const confirmed = readHolder();
        if (confirmed?.pid === process.pid) {
          lockPath = lock;
          return;
        }
        lastReason = `another process reclaimed ${lock} first (now held by ${confirmed?.pid ?? 'unknown'})`;
        if (Date.now() >= deadline) break;
        continue;
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

  // Close any handle already open. Releasing only the LOCK left the previous
  // SqlJsWrapper alive with the same path and a live debounce timer, so its
  // stale whole-file snapshot later landed on top of the new handle's work —
  // a ghost write that reverted committed data wholesale.
  closeDatabase();

  // Exclusive access: whole-file saves make concurrent writers destructive
  if (!options.readOnly) {
    await acquireDbLock(dbPath);
  }

  try {
    await openDatabase(dbPath, options.readOnly === true);
  } catch (error) {
    // Anything after acquireDbLock that throws used to leave the lock behind,
    // permanently locking the user out of their own database. The singleton
    // must go too: openDatabase assigns it before validating, so a failure left
    // getDatabase() handing out a live, WRITABLE handle onto a bad file — and
    // its next save would export that over the user's database.
    //
    // Nulling the singleton is NOT enough. openDatabase runs createTables
    // before the checks that can refuse, and createTables arms the wrapper's
    // debounced save — so the orphaned wrapper fired ~50ms after the refusal
    // and exported its whole-file snapshot over the very database we declined
    // to open, with the lock ALREADY RELEASED. Measured: a commit landed by
    // another writer just after the refusal was erased. That breaks both the
    // guard's own premise ("opening it with this build could discard data") and
    // the standing invariant that no handle may write without holding the lock.
    //
    // Reachable from every refusal that happens after the wrapper exists: the
    // newer-schema guard, a flushPendingPluginModels failure, and a torn file
    // whose corruption lies past page 1.
    const halfBuilt = db;
    db = null;
    if (halfBuilt) {
      try {
        halfBuilt.close({ save: false });
      } catch (closeError) {
        console.error('[Database] Could not discard the half-built handle:', closeError);
      }
    }
    releaseDbLock();
    throw error;
  }
}

async function openDatabase(dbPath: string, readOnly: boolean): Promise<void> {
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
    try {
      sqlDb = new SQL.Database(fileBuffer);
      // sql.js does not validate the header at construction — it defers until
      // the first statement — so this probe is what turns a non-database file
      // into an error we can attach the PATH to.
      sqlDb.exec('PRAGMA schema_version');
      // PRAGMA schema_version reads PAGE 1 ONLY, so a file with an intact
      // header and a corrupt body walked straight past it — a torn save, a
      // half-synced OneDrive copy, a bad sector: precisely what the atomic save
      // and renameWithRetry exist to prevent, and precisely the case where the
      // user needs the path and the recovery advice. The failure surfaced much
      // later out of runMigrations as sql.js's bare "database disk image is
      // malformed". Reading the schema table costs nothing and catches a little
      // more; the rest is caught where it actually surfaces, below — a full
      // PRAGMA integrity_check would read every page on every open, which is
      // O(file size) on a database this design already exports whole.
      sqlDb.exec('SELECT count(*) FROM sqlite_master');
    } catch (error) {
      // sql.js says only "file is not a database" or "database disk image is
      // malformed" — no path, no advice. A user who mistyped `--db notes.txt`
      // could not tell which file was meant. The zero-byte branch above
      // already sets the standard for this message.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${dbPath} is not a readable database (${detail}). ` +
        `Check the --db path, restore the file from backup, or delete it to start clean.`,
      );
    }
  } else {
    sqlDb = new SQL.Database();
  }

  db = new SqlJsWrapper(sqlDb, dbPath, readOnly);
  db.pragma('journal_mode = WAL');
  // The schema DECLARES foreign keys but SQLite ignores them unless this is on,
  // so a run could point at a deleted config and orphaned rows accumulated
  // invisibly.
  db.pragma('foreign_keys = ON');

  // Corruption past page 1 slips through the probe above and surfaces HERE,
  // as sql.js's bare "database disk image is malformed" with no path and no
  // advice. Re-dress it so a torn file reads the same as a mistyped --db.
  try {
    createTables(db);
    runMigrations(db);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/malformed|not a database|corrupt|disk image/i.test(detail)) {
      throw new Error(
        `${dbPath} is not a readable database (${detail}). ` +
        `Check the --db path, restore the file from backup, or delete it to start clean.`,
      );
    }
    throw error;
  }

  // Plugin providers registered before the database opened queued their
  // model catalog entries — flush them now. (Dynamic import avoids a static
  // registry ↔ database cycle.)
  const { flushPendingPluginModels } = await import('../registry.js');
  flushPendingPluginModels(db);
}

export function closeDatabase(): void {
  const closing = db;
  // Null the singleton FIRST. A throw inside close() used to leave `db`
  // pointing at a closed-or-closing handle, so getDatabase() kept answering
  // queries after quit and the lock was never released — and on the desktop
  // that throw escaped into Electron's before-quit sequence.
  db = null;
  if (closing) {
    try {
      closing.close();
    } catch (error) {
      console.error('[Database] Error while closing — the lock is still released:', error);
    }
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

  // (candidate_nodes was created here and never written by any production
  // code — nodes live inside evaluation_runs.run_json. Migration 5 drops it
  // from existing databases.)

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

/** The schema version this build understands. Bump with every new migration. */
const LATEST_SCHEMA_VERSION = 5;

function runMigrations(db: SqlJsWrapper): void {
  // Check current schema version
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion === 0) {
    // Fresh install - set up with latest schema (version 4) and models
    insertDefaultModelCosts(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_SCHEMA_VERSION);
    console.log(`Fresh install: Initialized with models (schema v${LATEST_SCHEMA_VERSION})`);
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

  // Migration 2: Update existing users from old model list to new one.
  //
  // Scoped to the providers this catalog actually owns. An unscoped
  // `DELETE FROM model_costs` also wiped every OpenRouter row the user had
  // synced, every Groq row (which insertDefaultModelCosts does NOT re-seed),
  // and every hand-entered price override. A missing row makes getModelCost
  // return null, which base.ts prices at $0 — so after this migration those
  // models billed nothing, totals.usd never grew, and budgetUSD could never
  // trip. Migration 3 below already used the scoped form.
  if (version === 1) {
    console.log('Running migration 2: Updating model costs to new models...');
    db.prepare("DELETE FROM model_costs WHERE provider IN ('openai', 'anthropic', 'gemini')").run();
    insertDefaultModelCosts(db);
    setVersion(2);
    console.log('Migration 2 completed - new models loaded (synced and custom prices preserved)');
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

  // Migration 5: Drop the never-written candidate_nodes table. Nodes live
  // inside evaluation_runs.run_json; this table was created on every install
  // and never written by any production code, so it was pure confusion for
  // anyone reading the schema.
  if (version === 4) {
    console.log('Running migration 5: Dropping unused candidate_nodes table...');
    db.exec('DROP TABLE IF EXISTS candidate_nodes');
    setVersion(5);
    console.log('Migration 5 completed');
    version = 5;
  }

  // Future migrations go here
  // if (version === 5) { ... }

  // A database written by a NEWER build than this one must not be touched:
  // runMigrations simply fell through anything it did not recognise, so an
  // older build opened it, queried it, and wrote its own understanding back on
  // close — silently discarding whatever the newer schema added.
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `This database was created by a newer version of PromptEngine (schema v${version}; this build understands v${LATEST_SCHEMA_VERSION}). ` +
      `Opening it with this build could discard data. Update PromptEngine, or point --db at a different file.`
    );
  }
}
