/**
 * BUG HARNESS — these two tests FAIL against the current source on purpose.
 * They are reproductions, not regression tests. Do not copy them into the repo
 * until the bugs are fixed.
 *
 *   cd C:\Users\user\AppData\Local\Temp\claude\hunt10-db\sandbox\packages\core
 *   npx vitest run tests/database/bug-harness.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/database/init.js';

const created: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `pe-bug-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  created.push(p);
  return p;
}
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  for (const p of created.splice(0)) {
    for (const suffix of ['', '.lock', '.tmp']) {
      try { fs.rmSync(`${p}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
  }
});

async function seed(dbPath: string): Promise<void> {
  await initializeDatabase(dbPath);
  getDatabase().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('seeded', 'yes');
  closeDatabase();
}

describe('BUG 1 — a torn database escapes the "not a readable database" guard', () => {
  it('reports the path and the recovery advice for corruption past page 1', async () => {
    // openDatabase probes a candidate file with `PRAGMA schema_version`, which
    // reads PAGE 1 ONLY. A file whose header and first page are intact but whose
    // body is corrupt — a torn save, a half-synced OneDrive copy, a bad sector,
    // exactly what the atomic-rename work exists to prevent — sails through the
    // probe. The failure then surfaces later, from runMigrations, as sql.js's
    // bare "database disk image is malformed": no path, no advice, and no way
    // for a user who passed the wrong --db to tell which file was meant.
    const good = tmpPath();
    await seed(good);
    const intact = fs.readFileSync(good);

    const dbPath = tmpPath();
    fs.writeFileSync(dbPath, Buffer.concat([
      intact.subarray(0, 4096),                       // header + page 1: valid
      Buffer.alloc(intact.length - 4096, 0x5a),       // everything after: garbage
    ]));

    let error: Error | undefined;
    try { await initializeDatabase(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeDefined();
    console.log('BUG1 observed message:', JSON.stringify(error?.message));
    expect(error!.message).toMatch(/is not a readable database/); // <-- FAILS today
    expect(error!.message).toContain(dbPath);
  }, 30000);
});

describe('BUG 2 — a REFUSED open still writes the file, without the lock', () => {
  it('does not touch a database it refused to open', async () => {
    // initializeDatabase's failure path is `db = null; releaseDbLock(); throw`.
    // It never closes the half-built SqlJsWrapper, and createTables has already
    // armed that wrapper's debounced save. ~50ms after the refusal the orphan
    // timer fires and exports its whole-file snapshot over the target — with the
    // lock already released.
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    getDatabase().prepare('DELETE FROM schema_version').run();
    getDatabase().prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    closeDatabase();

    const mtimeBefore = fs.statSync(dbPath).mtimeMs;
    await expect(initializeDatabase(dbPath)).rejects.toThrow(/newer version/);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false); // lock already gone

    await new Promise(resolve => setTimeout(resolve, 800));
    const mtimeAfter = fs.statSync(dbPath).mtimeMs;
    console.log('BUG2 mtime before/after refusal:', mtimeBefore, mtimeAfter);
    expect(mtimeAfter).toBe(mtimeBefore); // <-- FAILS today: the file was rewritten
  }, 30000);

  it('cannot erase a commit made by another writer after the refusal', async () => {
    // The consequence. The orphan save is a whole-file export of a snapshot
    // taken BEFORE the refusal, so anything committed in the window between the
    // refusal and the timer firing is wiped.
    const SQL: SqlJsStatic = await initSqlJs();
    const dbPath = tmpPath();
    await initializeDatabase(dbPath);
    getDatabase().prepare('DELETE FROM schema_version').run();
    getDatabase().prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    closeDatabase();

    await expect(initializeDatabase(dbPath)).rejects.toThrow(/newer version/);

    // Another process (the newer build that owns this schema) commits.
    const other = new SQL.Database(fs.readFileSync(dbPath));
    other.run("INSERT INTO app_settings (key, value) VALUES ('committed-after-refusal', 'yes')");
    fs.writeFileSync(dbPath, Buffer.from(other.export()));
    other.close();

    await new Promise(resolve => setTimeout(resolve, 800));

    const probe = new SQL.Database(fs.readFileSync(dbPath));
    const rows = probe.exec("SELECT value FROM app_settings WHERE key = 'committed-after-refusal'");
    probe.close();
    console.log('BUG2 concurrent commit survived:', rows.length > 0 ? 'yes' : 'NO — ERASED');
    expect(rows.length).toBe(1); // <-- FAILS today: erased by the orphan save
  }, 30000);
});
