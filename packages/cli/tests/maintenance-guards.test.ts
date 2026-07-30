import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { resolveDbPath, isSharedDesktopDb } from '../src/database.js';

/**
 * `--prune-runs` with no `--db` resolves to the SHARED desktop database, so
 * `--prune-runs 0` deleted every run visible in the app with no confirmation
 * and no undo. And with HOME and USERPROFILE both unset — a bare CI container,
 * a service account — resolveDbPath returned a RELATIVE path, so the database
 * landed in whatever the working directory happened to be and a second
 * invocation from elsewhere silently started from scratch.
 */
describe('resolveDbPath always returns an absolute path', () => {
  it('is absolute even with HOME and USERPROFILE unset', () => {
    const home = process.env.HOME;
    const profile = process.env.USERPROFILE;
    const appdata = process.env.APPDATA;
    try {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      delete process.env.APPDATA;
      const p = resolveDbPath();
      expect(path.isAbsolute(p)).toBe(true);
      expect(p).not.toBe(path.join('.promptengine', 'evolution.db'));
    } finally {
      if (home !== undefined) process.env.HOME = home;
      if (profile !== undefined) process.env.USERPROFILE = profile;
      if (appdata !== undefined) process.env.APPDATA = appdata;
    }
  });

  it('an explicit --db path is honoured and absolute', () => {
    const p = resolveDbPath('rel/at/ive.db');
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe('the shared desktop database is recognised', () => {
  it('does not flag an explicit scratch path as the desktop database', () => {
    const scratch = path.join(os.tmpdir(), 'pe-scratch.db');
    expect(isSharedDesktopDb(scratch)).toBe(false);
  });

  it('flags the path resolveDbPath picks with no --db', () => {
    // The first version asserted only `typeof ... === 'boolean'`, which passes
    // for `() => false` — i.e. for the guard being completely broken.
    // With no --db the CLI deliberately shares the desktop database, so this
    // must be true wherever that database is discoverable.
    const shared = resolveDbPath();
    const looksLikeDesktopDb = shared.includes('evolution2');
    if (looksLikeDesktopDb) {
      expect(isSharedDesktopDb(shared)).toBe(true);
    } else {
      // No Electron userData on this machine: the CLI fell back to
      // ~/.promptengine, which is NOT the desktop file and must not be guarded.
      expect(isSharedDesktopDb(shared)).toBe(false);
    }
  });
});
