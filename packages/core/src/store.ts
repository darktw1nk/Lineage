/**
 * Store module — provides a key/value store for API keys and settings.
 *
 * The host application must inject an implementation via setStore() before
 * any provider or engine code accesses settings:
 *   - Electron app: setStore(new ElectronStore(...)) in main.ts
 *   - CLI: setStore(createCliStore(...))
 */

export interface StoreInterface {
  get(key: string, defaultValue?: any): any;
  set(key: string, value: any): void;
  store: Record<string, any>;
}

let _store: StoreInterface = {
  get() { throw new Error('Store not initialized. The host must call setStore() before accessing settings.'); },
  set() { throw new Error('Store not initialized. The host must call setStore() before accessing settings.'); },
  store: {},
};

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
