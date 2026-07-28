import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeBacking } = vi.hoisted(() => ({ storeBacking: {} as Record<string, any> }));

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
vi.mock('@promptengine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@promptengine/core')>()),
  store: {
    get: (k: string, d?: any) => storeBacking[k] ?? d ?? null,
    set: (k: string, v: any) => { storeBacking[k] = v; },
    store: storeBacking,
  },
}));

import { registerPluginHandlers, setPluginState } from '../../electron/ipc/plugins';
import os from 'os';
import path from 'path';

const channels = new Map<string, (...args: any[]) => Promise<any>>();
const mockIpcMain = { handle: vi.fn((ch: string, fn: any) => { channels.set(ch, fn); }) } as any;
const invoke = (ch: string, ...args: any[]) => channels.get(ch)!({} as any, ...args);

beforeEach(() => {
  channels.clear();
  for (const k of Object.keys(storeBacking)) delete storeBacking[k];
  setPluginState({
    manifests: [
      { name: 'alpha', source: '/p/alpha.mjs', operators: ['op-a'], providers: [] },
      { name: 'beta', source: '/p/beta.mjs', operators: [], providers: [], error: 'boom' },
    ],
    pluginsDir: path.join(os.tmpdir(), `pe-plugins-test-${process.pid}`),
  });
  registerPluginHandlers(mockIpcMain);
});

describe('plugin IPC handlers', () => {
  it('plugins:list returns manifests and the disabled list', async () => {
    storeBacking['disabledPlugins'] = ['beta'];
    const res = await invoke('plugins:list');
    expect(res.manifests.map((m: any) => m.name)).toEqual(['alpha', 'beta']);
    expect(res.disabled).toEqual(['beta']);
  });

  it('plugins:setEnabled(false) adds to disabledPlugins; (true) removes', async () => {
    await invoke('plugins:setEnabled', 'alpha', false);
    expect(storeBacking['disabledPlugins']).toEqual(['alpha']);
    await invoke('plugins:setEnabled', 'alpha', true);
    expect(storeBacking['disabledPlugins']).toEqual([]);
  });

  it('plugins:openFolder creates the dir and opens it', async () => {
    const res = await invoke('plugins:openFolder');
    expect(res).toBe(true);
  });
});
