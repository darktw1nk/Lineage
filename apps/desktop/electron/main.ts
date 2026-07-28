import { app, BrowserWindow, ipcMain } from 'electron';
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
});

app.on('before-quit', () => {
  closeDatabase();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
