/**
 * CLI Store Shim
 *
 * Resolves API keys with priority: env var > CLI config file > electron-store.
 * Reads/writes the electron-store JSON file directly so keys are shared
 * between CLI and desktop app.
 */

import fs from 'fs';
import path from 'path';
import type { Provider } from '@promptengine/core';

const ENV_VAR_MAP: Record<Provider, string> = {
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
    const storePath = getElectronStorePath();
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // Could not read or parse — fall back gracefully
  }
  return {};
}

/**
 * Write a value to the electron-store JSON (merges with existing data).
 */
export function writeElectronStore(key: string, value: any): void {
  const storePath = getElectronStorePath();
  let data: Record<string, any> = {};

  try {
    if (fs.existsSync(storePath)) {
      data = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    }
  } catch {
    // Start fresh
  }

  // Support dotted keys like "apiKey.openrouter"
  const parts = key.split('.');
  let obj = data;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data, null, '\t'));
}

/**
 * Resolve an API key for a provider.
 * Priority: env var > cliConfigKeys > electron-store saved key.
 */
export function resolveApiKey(
  provider: Provider,
  cliConfigKeys?: Record<string, string>
): string | null {
  // 1. Environment variable
  const envVar = ENV_VAR_MAP[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }

  // 2. CLI config file key
  const configKey = CONFIG_KEY_MAP[provider];
  if (cliConfigKeys && configKey && cliConfigKeys[configKey]) {
    return cliConfigKeys[configKey];
  }

  // 3. Electron-store saved key
  const storeData = readElectronStore();
  const savedKey = storeData?.apiKey?.[provider];
  if (savedKey && typeof savedKey === 'string') {
    return savedKey;
  }

  return null;
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
