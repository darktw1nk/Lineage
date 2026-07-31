import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/store.js', () => ({
  resolveApiKey: () => null, saveApiKey: () => {}, installStoreShim: () => {},
}));

import { initializeDatabase, closeDatabase, getDatabase } from '@promptengine/core';

/**
 * Gaps mutation testing found in the maintenance WIRING (hunt 13).
 *
 * maintenance-cli.test.ts proves the commands run at all; maintenance.test.ts
 * and maintenance-guards.test.ts drive `pruneRuns` and `isSharedDesktopDb`
 * directly. Nothing joins them up, so three semantic mutations inside
 * handleMaintenance survived a fully green suite:
 *
 *   - deleting the shared-desktop-database refusal outright
 *   - dropping `archivedIds` from the pruneRuns call
 *   - counting SKIPPED archives as archived
 *
 * Each one silently deletes evaluation history the user still has. This is the
 * same shape as the outage that shipped last week: the fix was tested, the
 * function containing it was not.
 */

const scratch: string[] = [];
const tmp = (name: string) => {
  const p = path.join(os.tmpdir(), `pe-wire-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
  scratch.push(p);
  return p;
};
afterEach(() => {
  try { closeDatabase(); } catch { /* not open */ }
  for (const p of scratch.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(`${p}.lock`, { force: true }); } catch { /* best effort */ }
  }
});

function runCli(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  // --tsconfig is REQUIRED, or @promptengine/core resolves to the gitignored
  // dist build and this tests a stale copy (see maintenance-cli.test.ts).
  const r = spawnSync('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json',
    'packages/cli/src/index.ts', ...args], {
    encoding: 'utf-8', shell: true, env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('--prune-runs refuses the shared desktop database', () => {
  it('exits 1 without deleting anything when no --db was given', () => {
    // With no --db the CLI deliberately adopts the DESKTOP app's database, so
    // `--prune-runs 0` deleted every run visible in the UI with no confirmation
    // and no undo. isSharedDesktopDb has its own unit test; the branch in
    // handleMaintenance that CALLS it has none, so removing that branch
    // entirely is invisible to the suite.
    //
    // The whole point of a sandboxed environment here: getElectronDbPath reads
    // APPDATA / XDG_CONFIG_HOME / HOME, so this exercises the real code path
    // against a temp directory. A regression must never be able to reach the
    // user's actual evolution.db from a test run.
    const home = tmp('home');
    fs.mkdirSync(path.join(home, 'evolution2'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'evolution2'), { recursive: true });

    const { code, out } = runCli(['--prune-runs', '0'], {
      APPDATA: home, XDG_CONFIG_HOME: home, HOME: home, USERPROFILE: home,
    });

    expect(out).toMatch(/Refusing to prune/);
    expect(out).toMatch(/desktop app uses/);
    expect(code).toBe(1);
  }, 120000);
});

describe('--archive-runs --prune-runs never deletes what did not reach disk', () => {
  it('keeps a run whose archive write failed', async () => {
    // archiveRuns swallows per-run write failures into `skipped`. pruneRuns can
    // be told to delete only archived ids — and maintenance.test.ts proves it
    // honours that — but nothing checked that handleMaintenance actually PASSES
    // the set, or that it builds the set from `archived` rather than
    // `archived + skipped`. Either mutation deletes an unarchived run and exits
    // 0, which is the exact data loss the parameter was added to prevent.
    const dbPath = tmp('wire.db');
    await initializeDatabase(dbPath);
    const db = getDatabase();
    db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?,?,?,?)')
      .run('cfg', 'c', JSON.stringify({ id: 'cfg', name: 'c' }), 1);
    for (const [id, startedAt] of [['aaaa', 1], ['bbbb', 2]] as Array<[string, number]>) {
      const body = { id, configId: 'cfg', startedAt, status: 'finished', totals: {}, generations: [[]], cacheHits: 0, version: '1.0' };
      db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?,?,?,?,?)')
        .run(id, 'cfg', startedAt, JSON.stringify(body), '1.0');
    }
    closeDatabase();

    // Block one archive write by putting a DIRECTORY where its file must go.
    const archiveDir = tmp('arc');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(path.join(archiveDir, 'bbbb.json'));

    const { code, out } = runCli(['--archive-runs', archiveDir, '--prune-runs', '0', '--db', dbPath]);
    expect(out).toMatch(/Archived/);
    expect(code).toBe(0);

    await initializeDatabase(dbPath);
    const ids = (getDatabase().prepare('SELECT id FROM evaluation_runs').all() as Array<{ id: string }>)
      .map(r => r.id);
    // aaaa archived cleanly and may go; bbbb has no copy on disk and must stay.
    expect(ids).toContain('bbbb');
    expect(ids).not.toContain('aaaa');
  }, 120000);
});
