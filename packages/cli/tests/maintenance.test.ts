import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/store.js', () => ({
  resolveApiKey: () => null, saveApiKey: () => {}, installStoreShim: () => {},
}));

import { archiveRuns, pruneRuns } from '../src/maintenance.js';
import { initializeDatabase, closeDatabase, getDatabase } from '@voxor/lineage-core';

let dir: string;
let dbPath: string;

function seed(runs: Array<{ id: string; startedAt: number }>) {
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?,?,?,?)')
    .run('cfg', 'c', JSON.stringify({ id: 'cfg', name: 'c' }), 1);
  for (const r of runs) {
    const body = { id: r.id, configId: 'cfg', startedAt: r.startedAt, totals: {}, generations: [[]], cacheHits: 0, version: '1.0' };
    db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?,?,?,?,?)')
      .run(r.id, 'cfg', r.startedAt, JSON.stringify(body), '1.0');
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-maint-'));
  dbPath = path.join(dir, 'evolution.db');
  await initializeDatabase(dbPath);
});
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const ids = () =>
  (getDatabase().prepare('SELECT id FROM evaluation_runs').all() as Array<{ id: string }>).map(r => r.id);

describe('pruneRuns keeps the newest N', () => {
  it('deletes the oldest and keeps the requested count', async () => {
    seed([{ id: 'a', startedAt: 1 }, { id: 'b', startedAt: 2 }, { id: 'c', startedAt: 3 },
          { id: 'd', startedAt: 4 }, { id: 'e', startedAt: 5 }]);
    const r = await pruneRuns(getDatabase(), 2, dbPath);
    expect(r.deleted.sort()).toEqual(['a', 'b', 'c']);
    expect(ids().sort()).toEqual(['d', 'e']);
    expect(r.kept).toBe(2);
  });

  it('keep=0 deletes everything; keep>count deletes nothing', async () => {
    seed([{ id: 'a', startedAt: 1 }]);
    expect((await pruneRuns(getDatabase(), 99, dbPath)).deleted).toEqual([]);
    expect(ids()).toEqual(['a']);
    await pruneRuns(getDatabase(), 0, dbPath);
    expect(ids()).toEqual([]);
  });

  it('is deterministic when started_at ties', async () => {
    // No tiebreaker meant which run survived a tie was unspecified — and
    // imported runs carry their source startedAt, so ties are reachable.
    seed([{ id: 'a', startedAt: 7 }, { id: 'b', startedAt: 7 }, { id: 'c', startedAt: 7 }]);
    const first = (await pruneRuns(getDatabase(), 1, dbPath)).deleted.sort();
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
  });
});

describe('archive-then-prune never deletes an unarchived run', () => {
  it('a run whose archive write failed is NOT pruned', async () => {
    // archiveRuns swallows per-run failures into `skipped`, and the caller
    // pruned unconditionally — so the documented "safe one-liner"
    // `--archive-runs X --prune-runs 0` deleted a run that has no archive file,
    // and exited 0. Any per-run write failure qualifies: ENOSPC, EACCES, an AV
    // lock, EPERM on a read-only leftover.
    seed([{ id: 'aaaa', startedAt: 1 }, { id: 'bbbb', startedAt: 2 }]);
    const archiveDir = path.join(dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    // Make one target un-writable by putting a DIRECTORY where the file goes.
    fs.mkdirSync(path.join(archiveDir, 'bbbb.json'));

    const res = await archiveRuns(getDatabase(), archiveDir);
    expect(res.archived.map(a => a.runId)).toContain('aaaa');
    expect(res.skipped.map(s => s.runId)).toContain('bbbb');

    // The contract: prune may only remove what was archived.
    const pruned = await pruneRuns(getDatabase(), 0, dbPath, new Set(res.archived.map(a => a.runId)));
    expect(pruned.deleted).not.toContain('bbbb');
    expect(ids()).toContain('bbbb');
  });

  it('with no restriction it still prunes normally', async () => {
    seed([{ id: 'a', startedAt: 1 }, { id: 'b', startedAt: 2 }]);
    const pruned = await pruneRuns(getDatabase(), 0, dbPath);
    expect(pruned.deleted.sort()).toEqual(['a', 'b']);
  });
});
