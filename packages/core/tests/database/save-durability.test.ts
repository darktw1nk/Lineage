import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqlJsWrapper } from '../../src/database/init.js';

// ---------------------------------------------------------------------------
// Every save is a WHOLE-FILE export written to a sibling temp file and renamed
// over the target. These tests pin the three things that make that safe:
//   1. the rename survives the transient sharing violations Windows produces,
//   2. a save that genuinely fails is REPORTED and RETRIED, never swallowed,
//   3. a read-only handle never writes at all.
// A measured 72% of checkpoints were lost before (1) and (2) existed, and none
// of it was covered by a test.
// ---------------------------------------------------------------------------

let SQL: SqlJsStatic;
beforeAll(async () => { SQL = await initSqlJs(); });

const created: string[] = [];
const open: SqlJsWrapper[] = [];

function tmpPath(): string {
  const p = path.join(os.tmpdir(), `pe-savedur-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  created.push(p);
  return p;
}

function makeWrapper(dbPath: string, readOnly = false): SqlJsWrapper {
  const w = new SqlJsWrapper(new SQL.Database(), dbPath, readOnly);
  open.push(w);
  return w;
}

/** Read the file EXACTLY as a crash would leave it, with no waiting. */
function rowsOnDisk(dbPath: string, sql: string): unknown[] {
  const probe = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const res = probe.exec(sql);
    return res.length > 0 ? res[0].values.map(v => v[0]) : [];
  } finally {
    probe.close();
  }
}

/** Internals the tests need to observe; private in the implementation. */
type Internals = { _saveTimer: unknown };

afterEach(() => {
  // Restore fs BEFORE closing: close() saves, and a still-mocked rename would
  // make cleanup itself fail.
  vi.restoreAllMocks();
  for (const w of open.splice(0)) {
    try { w.close(); } catch { /* already closed */ }
  }
  for (const p of created.splice(0)) {
    for (const suffix of ['', '.lock', '.tmp']) {
      try { fs.rmSync(`${p}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
  }
});

/** Make fs.renameSync fail with `code` for the first `times` calls. */
function failRename(code: string, times: number): { calls: () => number } {
  const real = fs.renameSync;
  let calls = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    calls++;
    if (calls <= times) {
      const error = new Error(`${code}: simulated, rename '${String(from)}' -> '${String(to)}'`) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return real(from, to);
  });
  return { calls: () => calls };
}

/**
 * Wait for a condition instead of for a duration.
 *
 * These tests wait on a re-armed save timer. A fixed sleep encodes one
 * machine's speed: 600ms was ample locally and failed on a loaded CI runner,
 * which is a false alarm about durability — the least useful kind, since this
 * suite exists to prove data is never silently lost. Polling keeps the fast
 * path fast and only spends the extra time when the machine is slow.
 */
async function waitFor(
  condition: () => boolean,
  { timeoutMs = 10_000, intervalMs = 25, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

describe('atomic save: the rename retry (Windows sharing violations)', () => {
  it('retries a transient EPERM rename rather than dropping the checkpoint', () => {
    // Defender, Search Indexer, OneDrive, or our own lock-free --list-models
    // holding the target open for a few ms is enough for renameSync to fail
    // EPERM. One failed attempt used to lose the whole checkpoint.
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('checkpoint');

    const rename = failRename('EPERM', 3);
    expect(db.flush()).toBe(true);

    expect(rename.calls()).toBe(4); // 3 transient failures, then success
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['checkpoint']);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);
  });

  it('treats EBUSY and EACCES as transient too', () => {
    for (const code of ['EBUSY', 'EACCES']) {
      const dbPath = tmpPath();
      const db = makeWrapper(dbPath);
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run(code);

      const rename = failRename(code, 2);
      expect(db.flush(), code).toBe(true);
      expect(rename.calls(), code).toBe(3);
      expect(rowsOnDisk(dbPath, 'SELECT v FROM t'), code).toEqual([code]);
      vi.restoreAllMocks();
    }
  });

  it('does NOT spin on an error that will never clear', () => {
    // ENOSPC/EROFS are not sharing violations. Retrying them ten times with
    // synchronous Atomics.wait sleeps just blocks the process for nothing.
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rename = failRename('ENOSPC', Number.MAX_SAFE_INTEGER);

    expect(db.flush()).toBe(false);
    expect(rename.calls()).toBe(1); // fail fast: no retry loop
    expect(errors).toHaveBeenCalled();
  });

  it('gives up after a bounded number of attempts and reports failure', () => {
    // The retry must be bounded: a target held open forever (a stuck backup
    // agent) must surface as a failed save, not an infinite synchronous spin.
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rename = failRename('EPERM', Number.MAX_SAFE_INTEGER);

    expect(db.flush()).toBe(false);
    expect(rename.calls()).toBe(10);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false); // partial write cleaned up
  });
});

describe('a failed save is reported and retried, never swallowed', () => {
  it('flush() returns false when the data did not reach disk', () => {
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('lost?');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    failRename('ENOSPC', Number.MAX_SAFE_INTEGER);

    // Returning void/true here is what made persistRun report success for
    // checkpoints that never landed.
    expect(db.flush()).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('re-arms a retry after a failed flush, and the data lands once the fault clears', async () => {
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('survives');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = fs.renameSync;
    let failing = true;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failing) {
        const error = new Error('ENOSPC: simulated') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return real(from, to);
    });

    expect(db.flush()).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    // A swallowed failure used to leave NOTHING pending — the data was simply gone.
    expect((db as unknown as Internals)._saveTimer).not.toBeNull();

    failing = false;
    // Deliberately no further write: the re-armed timer alone must get it there.
    await waitFor(() => fs.existsSync(dbPath), { what: 're-armed save to reach disk' });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['survives']);
  }, 15000);

  it('a failed DEBOUNCED save retries with backoff instead of being dropped', async () => {
    // The debounced save runs on a timer, so an unguarded throw would kill the
    // Electron main process; catching it without rescheduling silently discarded
    // the data instead.
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rename = failRename('ENOSPC', 2); // two scheduled saves fail, the third works

    db.prepare('INSERT INTO t (v) VALUES (?)').run('debounced');
    await waitFor(() => fs.existsSync(dbPath), { what: 'debounced retry to reach disk' });

    expect(rename.calls()).toBeGreaterThanOrEqual(3); // it really did retry
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['debounced']);
  }, 15000);
});

describe('transaction durability', () => {
  it('an outermost commit is on disk immediately, without waiting for the debounce', () => {
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.flush(); // baseline: schema on disk, nothing pending

    db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('committed');
    })();

    // No await, no timer: this is exactly what a hard crash would leave behind.
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['committed']);
  });

  it('only the OUTERMOST commit flushes — an inner savepoint has committed nothing', () => {
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.flush();

    const rename = vi.spyOn(fs, 'renameSync');
    db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
      })();
    })();

    expect(rename).toHaveBeenCalledTimes(1); // one whole-file save, not one per level
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['outer', 'inner']);
  });

  it('refuses an async callback rather than committing before its work runs', () => {
    // A promise-returning callback COMMITs the instant the promise is created,
    // before any of its work has run — a later throw then "rolled back" nothing
    // and every write persisted. better-sqlite3 refuses these outright.
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');

    const bad = db.transaction(async () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('pretend-transactional');
    });

    expect(() => bad()).toThrow(/synchronous/);
    // and the work it did manage to do is rolled back, not left half-committed
    expect(db.prepare('SELECT v FROM t').all()).toEqual([]);
  });

  it('refuses any thenable, not just an async function', () => {
    const dbPath = tmpPath();
    const db = makeWrapper(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');

    const bad = db.transaction(() => ({ then: (resolve: () => void) => resolve() }));
    expect(() => bad()).toThrow(/synchronous/);
  });
});

describe('a read-only handle never writes the shared file', () => {
  it('cannot erase what another process committed after it opened', () => {
    // Every save is a whole-file export of the snapshot taken AT OPEN. A
    // read-only handle holds no lock, so it cannot know what has been committed
    // since — writing at all would roll the file back. `--list-models` and
    // `--estimate` were doing exactly this to the shared desktop database.
    const dbPath = tmpPath();

    const writer = makeWrapper(dbPath);
    writer.exec('CREATE TABLE t (v TEXT)');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('committed-by-writer');
    writer.flush();
    const bytesBefore = fs.readFileSync(dbPath);

    // sql.js takes OWNERSHIP of the buffer handed to it and edits it in place,
    // so the comparison copy has to be separate from the one it opens.
    const reader = new SqlJsWrapper(new SQL.Database(Buffer.from(bytesBefore)), dbPath, true);
    reader.prepare('DELETE FROM t').run();
    reader.prepare('INSERT INTO t (v) VALUES (?)').run('written-by-reader');
    expect(reader.flush()).toBe(true); // reports success — because it wrote nothing

    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['committed-by-writer']);
    expect(fs.readFileSync(dbPath).equals(bytesBefore)).toBe(true);

    // close() flushes as well; it must be just as inert.
    reader.close();
    expect(rowsOnDisk(dbPath, 'SELECT v FROM t')).toEqual(['committed-by-writer']);
    expect(fs.readFileSync(dbPath).equals(bytesBefore)).toBe(true);
  });

  it('does not even create the file when none exists', () => {
    const dbPath = tmpPath();
    const reader = new SqlJsWrapper(new SQL.Database(), dbPath, true);
    reader.exec('CREATE TABLE t (v TEXT)');
    reader.prepare('INSERT INTO t (v) VALUES (?)').run('nope');
    reader.flush();
    reader.close();
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);
  });
});
