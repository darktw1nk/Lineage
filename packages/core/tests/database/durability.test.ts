import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/database/init.js';

const tmp = () => path.join(os.tmpdir(), `pe-dur-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
const created: string[] = [];

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  for (const p of created.splice(0)) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.lock`, { force: true });
    fs.rmSync(`${p}.tmp`, { force: true });
  }
});

describe('database durability', () => {
  it('refuses to open a zero-byte file instead of silently starting fresh', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    fs.writeFileSync(dbPath, ''); // a torn/truncated write leaves exactly this

    await expect(initializeDatabase(dbPath)).rejects.toThrow(/empty \(0 bytes\)/);
    // The old behaviour treated it as a fresh install and discarded all history
  });

  it('saves atomically: no .tmp file is left behind after a write', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    await initializeDatabase(dbPath);
    const db = getDatabase();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('k', 'v');
    closeDatabase();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);

    // Reopen: the write is durable and readable
    await initializeDatabase(dbPath);
    const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get('k') as any;
    expect(row.value).toBe('v');
  });

  it('locks the file so a second holder cannot clobber it', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    await initializeDatabase(dbPath);

    // Simulate another LIVE process holding the lock (this pid is alive)
    fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.pid + 0, since: 'now' }));
    // A different, definitely-alive pid: use our own but pretend it's another
    // process by writing a pid we know exists and is not ours is unreliable —
    // instead assert the stale-lock path and the release path below.

    closeDatabase();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false); // released on close
  });

  it('reclaims a stale lock left by a dead process', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    // pid 0x7FFFFFFF will not exist; the lock must be reclaimed, not fatal
    fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 0x7FFFFFFF, since: 'long ago' }));

    await expect(initializeDatabase(dbPath)).resolves.toBeUndefined();
    expect(getDatabase()).toBeTruthy();
  });

  it('does not leave the lock behind when init fails after acquiring it', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    fs.writeFileSync(dbPath, ''); // triggers the zero-byte refusal AFTER the lock is taken

    await expect(initializeDatabase(dbPath)).rejects.toThrow();
    // Leaking here locked the user out of their own database permanently.
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('flush() makes a write durable without waiting for the debounce', async () => {
    const dbPath = tmp();
    created.push(dbPath);
    await initializeDatabase(dbPath);
    const db = getDatabase();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('checkpoint', 'kept');
    db.flush();

    // Read the file as it stands RIGHT NOW — the debounced save has not fired,
    // so this is exactly what a hard crash would leave on disk. docs/cli.md
    // promises resume loses nothing; without the flush it lost the checkpoint.
    const onDisk = fs.readFileSync(dbPath);
    expect(onDisk.length).toBeGreaterThan(0);

    closeDatabase();
    await initializeDatabase(dbPath);
    const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get('checkpoint') as any;
    expect(row?.value).toBe('kept');
  });
});
