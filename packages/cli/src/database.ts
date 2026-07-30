/**
 * CLI Database Initialization
 *
 * By default, shares the same database as the Electron app so synced
 * models and evaluation history are shared between CLI and desktop.
 * Falls back to a CLI-specific path if the Electron userData dir doesn't exist.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Resolve the database path for CLI use.
 * Priority: explicit --db flag > Electron app's database > CLI-specific fallback.
 */
export function resolveDbPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  // Try the Electron app's userData path
  const electronDbPath = getElectronDbPath();
  if (electronDbPath && fs.existsSync(path.dirname(electronDbPath))) {
    return electronDbPath;
  }

  // Fallback: CLI-specific path
  // os.homedir() as the last resort, not ''. With HOME and USERPROFILE both
  // unset — a bare CI container, a service account, a stripped-down shell — the
  // empty string made this a RELATIVE path, so the database landed in whatever
  // the current working directory happened to be and a second invocation from
  // another directory silently started from scratch.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || os.tmpdir();
  const cliDir = path.join(home, '.promptengine');
  const resolved = path.join(cliDir, 'evolution.db');
  return path.resolve(resolved);
}

function getElectronDbPath(): string | null {
  const appName = 'evolution2';
  const platform = process.platform;

  let appData: string;
  if (platform === 'win32') {
    appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    appData = path.join(process.env.HOME || '', 'Library', 'Application Support');
  } else {
    appData = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  }

  if (!appData) return null;

  return path.join(appData, appName, 'evolution.db');
}

/**
 * Initialize the database for CLI use.
 *
 * Pass readOnly for commands that only read the shared catalog
 * (`--list-models`, `--estimate`): they take no lock, so having the desktop app
 * open does not turn them into a hard failure.
 */
export async function initCliDatabase(explicitPath?: string, options: { readOnly?: boolean } = {}): Promise<void> {
  const dbPath = resolveDbPath(explicitPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Say which database, always. Without --db the CLI silently adopts the
  // DESKTOP app's database when its userData directory exists, and a
  // CLI-specific file under ~/.promptengine otherwise — so "my runs are
  // missing" and "the desktop shows runs I never started there" both have the
  // same invisible cause. stderr, so --output/JSON capture is unaffected.
  process.stderr.write(
    `Database: ${dbPath}${explicitPath ? '' : ' (default — pass --db to choose)'}\n`,
  );

  // Import the engine's database init — it accepts an optional dbPath
  const { initializeDatabase } = await import('@promptengine/core');
  await initializeDatabase(dbPath, { readOnly: options.readOnly });
}

/**
 * Is this the database the DESKTOP app owns?
 *
 * `--prune-runs` with no --db resolves to the shared desktop database, so
 * `--prune-runs 0` deleted every run visible in the UI without a prompt.
 */
export function isSharedDesktopDb(resolved: string): boolean {
  try {
    const desktop = getElectronDbPath();
    return !!desktop && path.resolve(resolved) === path.resolve(desktop);
  } catch {
    return false;
  }
}
