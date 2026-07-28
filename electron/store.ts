/**
 * Store module — provides a key/value store for API keys and settings.
 *
 * In Electron mode: uses electron-store (backed by the OS userData path).
 * In CLI mode: call setStore() before importing providers to inject a shim.
 */

interface StoreInterface {
  get(key: string): any;
  set(key: string, value: any): void;
  store: Record<string, any>;
}

let _store: StoreInterface;

try {
  const Store = require('electron-store');
  _store = new Store({
    encryptionKey: 'prompt-evolution-secure-key',
  });
} catch {
  // Not in Electron context — store must be set via setStore() before use
  _store = {
    get() { throw new Error('Store not initialized. Call setStore() in CLI mode before accessing keys.'); },
    set() { throw new Error('Store not initialized. Call setStore() in CLI mode before accessing keys.'); },
    store: {},
  };
}

export const store: StoreInterface = new Proxy({} as StoreInterface, {
  get(_target, prop: string) {
    return (typeof (_store as any)[prop] === 'function')
      ? (...args: any[]) => (_store as any)[prop](...args)
      : (_store as any)[prop];
  },
});

export function setStore(s: StoreInterface): void {
  _store = s;
}
