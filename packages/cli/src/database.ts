/**
 * CLI Database Initialization
 *
 * By default, shares the same database as the Electron app so synced
 * models and evaluation history are shared between CLI and desktop.
 * Falls back to a CLI-specific path if the Electron userData dir doesn't exist.
 */

import path from 'path';
import fs from 'fs';

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
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cliDir = path.join(home, '.promptengine');
  return path.join(cliDir, 'evolution.db');
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

  // Import the engine's database init — it accepts an optional dbPath
  const { initializeDatabase } = await import('@promptengine/core');
  await initializeDatabase(dbPath, { readOnly: options.readOnly });
}
