import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Drive the CLI as a PROCESS.
 *
 * `--archive-runs` and `--prune-runs` were 100% broken — every invocation died
 * with "Database not initialized" and exit 1 — while the suite stayed green,
 * because maintenance.test.ts calls archiveRuns/pruneRuns directly with an
 * already-open handle and maintenance-guards.test.ts calls isSharedDesktopDb
 * directly. Nothing exercised handleMaintenance, the function that wires them
 * to a database. The fix was tested; the function containing it was not.
 */
const scratch: string[] = [];
const tmp = (name: string) => {
  const p = path.join(os.tmpdir(), `pe-cli-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
  scratch.push(p);
  return p;
};
afterEach(() => {
  for (const p of scratch.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(`${p}.lock`, { force: true }); } catch { /* best effort */ }
  }
});

function runCli(args: string[]): { code: number; out: string } {
  // spawnSync, not execFileSync: the maintenance messages go to STDERR (the
  // documented contract), and execFileSync only surfaces stderr when the
  // process FAILS — so a success case read as empty and the assertion passed
  // for the wrong reason.
    // --tsconfig is REQUIRED. Without it `@voxor/lineage-core` resolves through the
  // package exports map to packages/core/dist, which is gitignored — so this
  // silently tested a STALE BUILD (it scored a wrong answer 6, a value removed
  // two commits earlier) and failed outright on a fresh clone with
  // ERR_MODULE_NOT_FOUND. The repo's own `cli` script passes it.
  const r = spawnSync('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json',
    'packages/cli/src/index.ts', ...args], {
    encoding: 'utf-8', shell: true,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the maintenance commands actually run', () => {
  it('--archive-runs opens the database and exits 0', () => {
    const db = tmp('a.db');
    const dir = tmp('arc');
    const { code, out } = runCli(['--archive-runs', dir, '--db', db]);
    expect(out).not.toMatch(/Database not initialized/);
    expect(code).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  }, 120000);

  it('--prune-runs opens the database and exits 0', () => {
    const db = tmp('p.db');
    const { code, out } = runCli(['--prune-runs', '5', '--db', db]);
    expect(out).not.toMatch(/Database not initialized/);
    expect(code).toBe(0);
  }, 120000);

  it('the combined one-liner archives even though it also prunes', () => {
    const db = tmp('c.db');
    const dir = tmp('arc2');
    const { code, out } = runCli(['--archive-runs', dir, '--prune-runs', '20', '--db', db]);
    expect(out).toMatch(/Archived/);
    expect(code).toBe(0);
  }, 120000);
});
