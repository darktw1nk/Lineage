import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/database/init.js';

// ---------------------------------------------------------------------------
// Saves are whole-file writes of the snapshot taken at open, so two processes
// on one file silently erase each other's committed work — and the CLI defaults
// to the DESKTOP's database, which makes that the normal case. The pid lock is
// the only thing standing in the way, and none of it was covered.
//
// `process.kill(pid, 0)` is stubbed rather than spawning real processes: the
// distinction that matters (ESRCH means gone, EPERM means alive-but-not-ours)
// cannot be produced reliably from a test otherwise.
// ---------------------------------------------------------------------------

const created: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `pe-lock-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  created.push(p);
  return p;
}

/** A pid that is definitely not ours; liveness is decided by the stub below. */
const FOREIGN_PID = 424242;
const RIVAL_PID = 424243;

function holdLock(dbPath: string, pid: number): void {
  fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid, since: '2026-07-30T00:00:00.000Z' }));
}
function lockHolder(dbPath: string): number | null {
  try { return JSON.parse(fs.readFileSync(`${dbPath}.lock`, 'utf-8')).pid; } catch { return null; }
}
function stubLiveness(fn: (pid: number) => boolean | never): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => fn(pid)) as typeof process.kill);
}
function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Seed a real, valid database file at `dbPath` and release it. */
async function seedDatabase(dbPath: string): Promise<void> {
  await initializeDatabase(dbPath);
  getDatabase().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('seeded', 'yes');
  closeDatabase();
}

afterEach(() => {
  vi.restoreAllMocks();
  try { closeDatabase(); } catch { /* already closed */ }
  for (const p of created.splice(0)) {
    for (const suffix of ['', '.lock', '.tmp']) {
      try { fs.rmSync(`${p}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
  }
});

describe('the lock refuses to steal a live holder', () => {
  it('will not take a lock another running process holds', async () => {
    // The create must be atomic create-or-FAIL. A plain overwrite would hand
    // both processes a writable handle onto one file.
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, FOREIGN_PID);
    stubLiveness(() => true); // the holder answers signal 0: it is alive

    await expect(initializeDatabase(dbPath)).rejects.toThrow(
      new RegExp(`in use by process ${FOREIGN_PID}`),
    );
    expect(lockHolder(dbPath)).toBe(FOREIGN_PID); // still theirs, untouched
    expect(() => getDatabase()).toThrow(/not initialized/);
  }, 20000);

  it('EPERM from the liveness probe means alive, not dead', async () => {
    // Only ESRCH proves the holder is gone. EPERM means the process exists but
    // belongs to another user or an elevated session — reading that as "dead"
    // stole live locks in exactly the case where the lock matters most.
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, FOREIGN_PID);
    stubLiveness(() => { throw errno('EPERM'); });

    await expect(initializeDatabase(dbPath)).rejects.toThrow(
      new RegExp(`in use by process ${FOREIGN_PID}`),
    );
    expect(lockHolder(dbPath)).toBe(FOREIGN_PID);
  }, 20000);

  it('ESRCH means gone: the stale lock is reclaimed', async () => {
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, FOREIGN_PID);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubLiveness(() => { throw errno('ESRCH'); });

    await expect(initializeDatabase(dbPath)).resolves.toBeUndefined();
    expect(lockHolder(dbPath)).toBe(process.pid);
    expect(warn).toHaveBeenCalled();
    // the seeded data is intact — reclaiming is not the same as starting fresh
    const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get('seeded') as { value: string };
    expect(row.value).toBe('yes');
  }, 20000);

  it('a lock recording OUR OWN pid is re-taken, not waited on', async () => {
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, process.pid);

    const startedAt = Date.now();
    await expect(initializeDatabase(dbPath)).resolves.toBeUndefined();
    // Waiting out the full 3s deadline against ourselves would be a deadlock
    // with extra steps.
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(lockHolder(dbPath)).toBe(process.pid);
  }, 20000);
});

describe('stale-lock reclaim is claim-then-VERIFY', () => {
  it('backs off when a rival wins the same reclaim during the settle window', async () => {
    // Two processes that read the same dead pid must not both "win". The claim
    // is written, then re-read after a settle delay; the loser sees someone
    // else's pid and goes back to waiting.
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, FOREIGN_PID);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubLiveness((pid: number) => {
      if (pid === FOREIGN_PID) throw errno('ESRCH'); // the recorded holder is gone
      return true;                                    // the rival is alive
    });

    // The rival overwrites our claim as soon as it appears.
    const rival = setInterval(() => {
      if (lockHolder(dbPath) === process.pid) holdLock(dbPath, RIVAL_PID);
    }, 20);

    try {
      await expect(initializeDatabase(dbPath)).rejects.toThrow(new RegExp(String(RIVAL_PID)));
    } finally {
      clearInterval(rival);
    }
    expect(lockHolder(dbPath)).toBe(RIVAL_PID);
    expect(() => getDatabase()).toThrow(/not initialized/);
  }, 30000);
});

describe('read-only opens bypass the lock entirely', () => {
  it('creates no lock file of its own', async () => {
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);

    await initializeDatabase(dbPath, { readOnly: true });
    // Checked while the handle is still OPEN: taking the lock here would lock a
    // user out of their own desktop app for the duration of `--list-models`.
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    expect(getDatabase()).toBeTruthy();
  }, 20000);

  it('opens even while another live process holds the lock, and leaves it alone', async () => {
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    holdLock(dbPath, FOREIGN_PID);
    stubLiveness(() => true);

    await expect(initializeDatabase(dbPath, { readOnly: true })).resolves.toBeUndefined();
    const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get('seeded') as { value: string };
    expect(row.value).toBe('yes');
    expect(lockHolder(dbPath)).toBe(FOREIGN_PID); // the writer keeps its lock
  }, 20000);

  it('and its handle still refuses to write the file', async () => {
    const dbPath = tmpPath();
    await seedDatabase(dbPath);
    const bytesBefore = fs.readFileSync(dbPath);

    await initializeDatabase(dbPath, { readOnly: true });
    const db = getDatabase();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('reader', 'should not persist');
    expect(db.flush()).toBe(true);
    closeDatabase();

    expect(fs.readFileSync(dbPath).equals(bytesBefore)).toBe(true);
  }, 20000);
});
