/**
 * CLI Store Shim
 *
 * Resolves API keys with priority: env var > CLI config file > electron-store.
 *
 * Uses `conf` — the same library electron-store is built on — with the desktop's
 * encryption key, so both apps read and write ONE format. Hand-rolled JSON
 * parsing here previously failed silently against the desktop's encrypted file:
 * every desktop-saved key looked absent, and `--set-key` then rewrote the file
 * from an empty object, destroying the user's other settings.
 */

import fs from 'fs';
import path from 'path';
import Conf from 'conf';
import type { Provider } from '@promptengine/core';

// Must match apps/desktop/electron/main.ts. It is a hardcoded constant in an
// open-source repo, so it provides obfuscation rather than security — but the
// two processes MUST agree on it or they cannot read each other's store.
const STORE_ENCRYPTION_KEY = 'prompt-evolution-secure-key';

let storeInstance: Conf<Record<string, any>> | null = null;
let storeDirOverride: string | null = null;

function getStore(): Conf<Record<string, any>> {
  if (!storeInstance) {
    storeInstance = new Conf<Record<string, any>>({
      cwd: storeDirOverride ?? path.dirname(getElectronStorePath()),
      configName: 'config',
      encryptionKey: STORE_ENCRYPTION_KEY,
    });
  }
  return storeInstance;
}

const ENV_VAR_MAP: Partial<Record<Provider, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
};

const CONFIG_KEY_MAP: Record<Provider, string> = {
  openai: 'openaiKey',
  anthropic: 'anthropicKey',
  gemini: 'geminiKey',
  openrouter: 'openrouterKey',
  groq: 'groqKey',
};

/**
 * Get the electron-store config.json path for this platform.
 * electron-store (via conf) uses: {appData}/{appName}/config.json
 */
export function getElectronStorePath(): string {
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

  return path.join(appData, appName, 'config.json');
}

/**
 * Read the electron-store JSON. Returns empty object on failure.
 */
export function readElectronStore(): Record<string, any> {
  try {
    if (!fs.existsSync(getElectronStorePath())) return {};
    return { ...getStore().store };
  } catch (error) {
    // Loud, not silent: an unreadable store used to look identical to
    // "no keys configured", which sent users hunting the wrong problem.
    console.error(`[Store] Could not read ${getElectronStorePath()}:`, error instanceof Error ? error.message : error);
    return {};
  }
}

/**
 * Write a value to the electron-store JSON (merges with existing data).
 */
export function writeElectronStore(key: string, value: any): void {
  // conf handles dotted keys, merging, atomic writes and encryption — matching
  // the desktop byte for byte. The previous read-modify-write silently reset
  // `data` to {} whenever the read failed, wiping every other stored setting.
  if (value === undefined) {
    getStore().delete(key); // conf rejects set(key, undefined)
    return;
  }
  getStore().set(key, value);
}

/** Testing seam: point the store at a scratch directory and drop the cache. */
export function __setStoreDirForTests(dir: string | null): void {
  storeDirOverride = dir;
  storeInstance = null;
}

/**
 * Resolve an API key for a provider.
 * Priority: env var > cliConfigKeys > electron-store saved key.
 */
export function resolveApiKey(
  provider: Provider,
  cliConfigKeys?: Record<string, string>
): string | null {
  // Trim every source. `$(cat key.txt)` carries a trailing newline and a
  // whitespace-only value passed straight through as a "key", producing a
  // confusing 401 instead of the clear "no API key found" the user needs.
  const clean = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  // 1. Environment variable (plugin providers use <PROVIDER>_API_KEY)
  const envVar = ENV_VAR_MAP[provider] ?? `${String(provider).toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const fromEnv = envVar ? clean(process.env[envVar]) : null;
  if (fromEnv) return fromEnv;

  // 2. CLI config file key
  const configKey = CONFIG_KEY_MAP[provider];
  const fromConfig = cliConfigKeys && configKey ? clean(cliConfigKeys[configKey]) : null;
  if (fromConfig) return fromConfig;

  // 3. Electron-store saved key
  const storeData = readElectronStore();
  return clean(storeData?.apiKey?.[provider]);
}

/**
 * Save an API key to electron-store (shared with desktop app).
 */
export function saveApiKey(provider: Provider, key: string): void {
  writeElectronStore(`apiKey.${provider}`, key);
}

/**
 * Create a mock store object matching electron-store's interface,
 * for use as a drop-in replacement when importing the store module.
 */
export function createCliStore(cliConfigKeys?: Record<string, string>, systemPrompts?: Record<string, any>): { get: (key: string) => any; set: (key: string, value: any) => void; store: Record<string, any> } {
  return {
    get(key: string): any {
      // Handle "apiKey.openai" format
      const match = key.match(/^apiKey\.(.+)$/);
      if (match) {
        const provider = match[1] as Provider;
        return resolveApiKey(provider, cliConfigKeys);
      }
      // Handle systemPrompts override from CLI config
      if (key === 'systemPrompts' && systemPrompts) {
        return systemPrompts;
      }
      // Fall back to electron-store data
      const data = readElectronStore();
      const parts = key.split('.');
      let val: any = data;
      for (const p of parts) {
        val = val?.[p];
      }
      return val ?? null;
    },
    set(key: string, value: any): void {
      writeElectronStore(key, value);
    },
    get store() {
      return readElectronStore();
    },
  };
}
