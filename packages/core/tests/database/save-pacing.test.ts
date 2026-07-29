import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/database/init.js';

const created: string[] = [];
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  for (const p of created.splice(0)) {
    for (const suffix of ['', '.lock', '.tmp']) fs.rmSync(`${p}${suffix}`, { force: true });
  }
});

/** Count physical writes by watching the file's mtime+size change. */
async function countSaves(work: () => Promise<void>, dbPath: string): Promise<number> {
  let saves = 0;
  let last = '';
  const poll = setInterval(() => {
    try {
      const s = fs.statSync(dbPath);
      const sig = `${s.mtimeMs}:${s.size}`;
      if (sig !== last) { last = sig; saves++; }
    } catch { /* not written yet */ }
  }, 5);
  await work();
  clearInterval(poll);
  return saves;
}

describe('save pacing', () => {
  it('backs the save interval off as saves get expensive', async () => {
    // Every save is a whole-file export whose cost scales with TOTAL DATABASE
    // SIZE — accumulated history, not the run being written. Measured 13ms at
    // 1.3MB and 80ms at 50MB. A fixed 50ms debounce meant a large database
    // spent most of its time writing itself out.
    //
    // Asserted on the pacing itself rather than a save COUNT: how many saves a
    // workload produces depends on how fast the caller writes, so a count-based
    // assertion passes with or without the fix (I checked — mine did).
    const dbPath = path.join(os.tmpdir(), `pe-pace-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    created.push(dbPath);
    await initializeDatabase(dbPath);
    const db = getDatabase();
    const wrapper = db as unknown as { _adaptiveDelayMs(): number; _lastSaveDurationMs: number };

    // A cheap save keeps the original 50ms — small databases behave as before.
    wrapper._lastSaveDurationMs = 1;
    expect(wrapper._adaptiveDelayMs()).toBe(50);

    // An expensive one backs off proportionally, capping the share of wall time
    // spent saving at roughly 10%.
    wrapper._lastSaveDurationMs = 43;   // ~25MB database
    expect(wrapper._adaptiveDelayMs()).toBe(430);
    wrapper._lastSaveDurationMs = 80;   // ~50MB database
    expect(wrapper._adaptiveDelayMs()).toBe(800);

    // And it is bounded, so a pathological save cannot stall writes forever.
    wrapper._lastSaveDurationMs = 60_000;
    expect(wrapper._adaptiveDelayMs()).toBe(5000);
  }, 30000);

  it('still writes to disk without an explicit flush', async () => {
    const dbPath = path.join(os.tmpdir(), `pe-pace3-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    created.push(dbPath);
    await initializeDatabase(dbPath);
    const db = getDatabase();

    const saves = await countSaves(async () => {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('debounced', 'yes');
      await new Promise(r => setTimeout(r, 400));
    }, dbPath);
    expect(saves).toBeGreaterThan(0);
  }, 30000);

  it('an explicit flush is still immediately durable', async () => {
    const dbPath = path.join(os.tmpdir(), `pe-pace2-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    created.push(dbPath);
    await initializeDatabase(dbPath);
    const db = getDatabase();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('durable', 'yes');
    expect(db.flush()).toBe(true);

    closeDatabase();
    await initializeDatabase(dbPath);
    const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get('durable') as any;
    expect(row?.value).toBe('yes');
  }, 30000);
});
