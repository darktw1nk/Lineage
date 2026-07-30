import { describe, it, expect, vi, afterEach } from 'vitest';
import initSqlJs from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/database/init.js';

// ---------------------------------------------------------------------------
// What this build will and will not OPEN, and what a migration is allowed to
// throw away. Both are refusals — the kind of code that looks like it works
// right up until the day it silently does the wrong thing to a real database.
// ---------------------------------------------------------------------------

const created: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `pe-schema-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  created.push(p);
  return p;
}

async function expectRejection(dbPath: string, options?: { readOnly?: boolean }): Promise<Error> {
  try {
    await initializeDatabase(dbPath, options);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`initializeDatabase(${dbPath}) resolved but should have been refused`);
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

describe('refusing to open a file that is not a database', () => {
  it('names the path and leaves the file alone', async () => {
    // sql.js does not validate the header at construction — it defers until the
    // first statement — and then says only "file is not a database": no path, no
    // advice. A user who mistyped `--db notes.txt` could not tell which file was
    // meant, and the mistyped file must not be adopted or overwritten.
    const dbPath = tmpPath();
    const original = 'these are my notes, not a database\n'.repeat(40);
    fs.writeFileSync(dbPath, original);

    const error = await expectRejection(dbPath);
    expect(error.message).toMatch(/is not a readable database/);
    expect(error.message).toContain(dbPath);

    expect(fs.readFileSync(dbPath, 'utf-8')).toBe(original); // untouched
    expect(() => getDatabase()).toThrow(/not initialized/);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false); // no lock left behind
  }, 20000);

  it('refuses a file whose header is right but whose body is empty', async () => {
    // Just the 100-byte SQLite header and nothing else. `PRAGMA schema_version`
    // (the probe) reads page 1, so this is the deepest corruption the current
    // guard actually catches.
    //
    // NOTE: corruption BEYOND page 1 is not caught here — see the bug harness
    // for `database disk image is malformed`, which escapes with no path.
    const dbPath = tmpPath();
    fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\0', 'binary'));

    const error = await expectRejection(dbPath);
    expect(error.message).toMatch(/is not a readable database/);
    expect(error.message).toContain(dbPath);
  }, 20000);
});

describe('refusing a schema written by a NEWER build', () => {
  it('will not open v6 with a v5 build', async () => {
    // runMigrations used to fall through anything it did not recognise, so an
    // older build opened the file, queried it, and wrote its own understanding
    // back on close — silently discarding whatever the newer schema added.
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    const db = getDatabase();
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('written-by-v6', 'keep me');
    closeDatabase();

    const error = await expectRejection(dbPath);
    expect(error.message).toMatch(/newer version of PromptEngine \(schema v6/);
    expect(error.message).toMatch(/this build understands v5/);
    expect(() => getDatabase()).toThrow(/not initialized/);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);

    // The newer build's data is still on disk.
    const SQL = await initSqlJs();
    const probe = new SQL.Database(fs.readFileSync(dbPath));
    try {
      const rows = probe.exec("SELECT value FROM app_settings WHERE key = 'written-by-v6'");
      expect(rows[0].values[0][0]).toBe('keep me');
      const version = probe.exec('SELECT version FROM schema_version');
      expect(version[0].values[0][0]).toBe(6); // not rewritten down to 5
    } finally {
      probe.close();
    }
  }, 20000);

  it('a read-only open is refused just as firmly', async () => {
    // --list-models takes no lock, but reading a schema it does not understand
    // is still reading the wrong columns.
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    getDatabase().prepare('DELETE FROM schema_version').run();
    getDatabase().prepare('INSERT INTO schema_version (version) VALUES (?)').run(99);
    closeDatabase();

    const error = await expectRejection(dbPath, { readOnly: true });
    expect(error.message).toMatch(/schema v99/);
  }, 20000);

  it('the CURRENT version still opens — the guard is > not >=', async () => {
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    expect((getDatabase().prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(5);
    closeDatabase();
    await expect(initializeDatabase(dbPath)).resolves.toBeUndefined();
    closeDatabase();
    await expect(initializeDatabase(dbPath)).resolves.toBeUndefined();
  }, 20000);
});

describe('migration 2 must not wipe prices it does not own', () => {
  it('keeps synced OpenRouter, Groq and other-provider rows', async () => {
    // An unscoped `DELETE FROM model_costs` also took every OpenRouter row the
    // user had synced and every Groq row — and insertDefaultModelCosts does NOT
    // re-seed Groq, so those prices were gone for good. A missing row makes
    // getModelCost return null, which evaluator_v2 prices at $0: after the
    // migration those models billed nothing and budgetUSD could never trip.
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    let db = getDatabase();

    const upsert = `INSERT OR REPLACE INTO model_costs
      (provider, model, prompt_usd_per_1k, completion_usd_per_1k) VALUES (?, ?, ?, ?)`;
    db.prepare(upsert).run('openrouter', 'meta-llama/llama-4-maverick', 0.0002, 0.0008);
    db.prepare(upsert).run('groq', 'llama-3.3-70b-versatile', 0.00059, 0.00079);

    // Rewind to schema v1 so reopening runs migration 2.
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    closeDatabase();

    await initializeDatabase(dbPath);
    db = getDatabase();

    const openrouter = db.prepare(
      "SELECT prompt_usd_per_1k AS p FROM model_costs WHERE provider = 'openrouter' AND model = 'meta-llama/llama-4-maverick'",
    ).get() as { p: number } | undefined;
    expect(openrouter?.p).toBe(0.0002);

    // Groq is the sharpest case: nothing ever re-seeds it.
    const groq = db.prepare(
      "SELECT completion_usd_per_1k AS c FROM model_costs WHERE provider = 'groq' AND model = 'llama-3.3-70b-versatile'",
    ).get() as { c: number } | undefined;
    expect(groq?.c).toBe(0.00079);

    // and the migration chain still completed
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(5);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM model_costs WHERE provider = 'openai'").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  }, 20000);
});
