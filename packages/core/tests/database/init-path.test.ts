import { describe, it, expect, afterEach } from 'vitest';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('initializeDatabase', () => {
  it('rejects an empty database path instead of falling back to Electron', async () => {
    await expect(initializeDatabase('')).rejects.toThrow(/requires a database file path/);
  });
});

describe('model catalog seeding', () => {
  const tmpDb = path.join(os.tmpdir(), `pe-seed-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  });

  it('seeds a fresh database at schema v3 without retired models', async () => {
    await initializeDatabase(tmpDb);
    const db = getDatabase();

    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as any;
    expect(version.version).toBe(3);

    const retired = db.prepare("SELECT COUNT(*) as n FROM model_costs WHERE model LIKE 'gemini-2.0%'").get() as any;
    expect(retired.n).toBe(0);

    const lite = db.prepare("SELECT * FROM model_costs WHERE provider = 'gemini' AND model = 'gemini-2.5-flash-lite'").get() as any;
    expect(lite).toBeTruthy();
    expect(lite.prompt_usd_per_1k).toBeCloseTo(0.0001, 10);
  });

  it('migration 3 refreshes provider models but preserves openrouter rows', async () => {
    await initializeDatabase(tmpDb);
    let db = getDatabase();

    // Rewind to schema v2 with a stale catalog + a synced openrouter row
    db.prepare('DELETE FROM model_costs').run();
    db.prepare('UPDATE schema_version SET version = 2').run();
    const insert = 'INSERT INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k) VALUES (?, ?, ?, ?)';
    db.prepare(insert).run('gemini', 'gemini-2.0-flash', 0.0001, 0.0004);
    db.prepare(insert).run('openrouter', 'meta-llama/llama-4-maverick', 0.0001, 0.0004);
    closeDatabase();

    // Reopen — triggers migration 3
    await initializeDatabase(tmpDb);
    db = getDatabase();

    expect((db.prepare("SELECT COUNT(*) as n FROM model_costs WHERE model = 'gemini-2.0-flash'").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as n FROM model_costs WHERE provider = 'openrouter'").get() as any).n).toBe(1);
    expect((db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as any).version).toBe(3);
  });
});
