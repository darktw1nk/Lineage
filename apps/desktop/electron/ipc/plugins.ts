import type { IpcMain } from 'electron';
import fs from 'fs';
import { store, type PluginManifest } from '@voxor/lineage-core';

interface PluginState {
  manifests: PluginManifest[];
  pluginsDir: string;
}

let state: PluginState = { manifests: [], pluginsDir: '' };

export function setPluginState(next: PluginState): void {
  state = next;
}

export function registerPluginHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('plugins:list', async () => ({
    manifests: state.manifests,
    disabled: (store.get('disabledPlugins', []) as string[]) ?? [],
  }));

  ipcMain.handle('plugins:setEnabled', async (_event, name: string, enabled: boolean) => {
    const disabled = new Set((store.get('disabledPlugins', []) as string[]) ?? []);
    if (enabled) disabled.delete(name); else disabled.add(name);
    store.set('disabledPlugins', [...disabled]);
    return [...disabled];
  });

  ipcMain.handle('plugins:openFolder', async () => {
    const { shell } = await import('electron');
    fs.mkdirSync(state.pluginsDir, { recursive: true });
    await shell.openPath(state.pluginsDir);
    return true;
  });
}
