import { describe, it, expect } from 'vitest';
import { store, setStore } from '../../../electron/store.js';

// NOTE: module-level singleton — these tests run in order within this file.
describe('core store (host-injected)', () => {
  it('throws an actionable error when used before setStore()', () => {
    expect(() => store.get('apiKeys')).toThrow(/setStore/);
    expect(() => store.set('x', 1)).toThrow(/setStore/);
  });

  it('delegates to the injected store after setStore()', () => {
    const backing: Record<string, any> = {};
    setStore({
      get: (k: string) => backing[k],
      set: (k: string, v: any) => { backing[k] = v; },
      store: backing,
    });
    store.set('apiKeys', { openai: 'k' });
    expect(store.get('apiKeys')).toEqual({ openai: 'k' });
    expect(store.store).toBe(backing);
  });
});
