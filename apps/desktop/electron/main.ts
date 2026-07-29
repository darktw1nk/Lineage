import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { initializeDatabase, closeDatabase, setStore, setSendUpdate, loadPlugins, type StoreInterface } from '@promptengine/core';
import { registerIPCHandlers } from './ipc/handlers.js';
import { registerPluginHandlers, setPluginState } from './ipc/plugins.js';
import { initLogger, getLogBuffer } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize logger early to capture all logs
initLogger();

let mainWindow: BrowserWindow | null = null;

// One instance only. Without this a second launch — double-clicking the icon —
// raced the first for the database lock and died with a dialog that blamed
// plugins, which is both wrong and unactionable. Focus the existing window
// instead, which is what the user meant.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.0,
      disableBlinkFeatures: 'Accelerated2dCanvas',
    },
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  // `app.quit()` above is asynchronous, so whenReady still fires for the losing
  // instance and runs this body until its first await — constructing an
  // electron-store against the same file the winner owns. It happened not to
  // reach loadPlugins or initializeDatabase, but only by timing. Make it a
  // guarantee.
  if (!gotTheLock) return;

  // Inject platform services into the engine (host-provided: store, update sender, db path)
  const electronStore = new Store({ encryptionKey: 'prompt-evolution-secure-key' }) as unknown as StoreInterface;
  setStore(electronStore);

  setSendUpdate((runId, data) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(`eval:updates:${runId}`, data);
    }
  });

  // Load plugins BEFORE the database opens so plugin provider model entries
  // flush into the catalog. Disabled plugins are skipped (Settings → Plugins).
  const pluginsDir = path.join(app.getPath('userData'), 'plugins');
  const disabledPlugins = (electronStore.get('disabledPlugins', []) as string[]) ?? [];
  const pluginManifests = await loadPlugins({ dirs: [pluginsDir], disabled: disabledPlugins });
  setPluginState({ manifests: pluginManifests, pluginsDir });

  await initializeDatabase(path.join(app.getPath('userData'), 'evolution.db'));

  // Register IPC handlers
  registerIPCHandlers(ipcMain);
  registerPluginHandlers(ipcMain);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  // Without this, a throw during startup (e.g. a malformed plugin poisoning the
  // model catalog) leaves the app running with NO window and NO error — the
  // user cannot even reach Settings to disable the offending plugin.
  console.error('[Main] Startup failed:', error);
  const message = error instanceof Error ? error.message : String(error);
  // Tailor the advice to the actual failure. Blaming plugins for a database
  // lock — the commonest cause, and the one a second launch produces — sent
  // the user to delete plugins that were not the problem.
  const advice = /in use by process|could not be read/i.test(message)
    ? 'Another PromptEngine process has the database open. Close it and try again, ' +
      'or start this one with a different --db path.'
    : `If you recently added a plugin, remove it from the plugins folder and restart:\n${path.join(app.getPath('userData'), 'plugins')}`;
  dialog.showErrorBox('PromptEngine.AI failed to start', `${message}\n\n${advice}`);
  app.quit();
});

app.on('before-quit', () => {
  closeDatabase();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
