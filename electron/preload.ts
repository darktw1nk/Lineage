const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Evaluation methods
  eval: {
    create: (config) => ipcRenderer.invoke('eval:create', config),
    start: (runId) => ipcRenderer.invoke('eval:start', runId),
    pause: (runId) => ipcRenderer.invoke('eval:pause', runId),
    resume: (runId) => ipcRenderer.invoke('eval:resume', runId),
    stop: (runId) => ipcRenderer.invoke('eval:stop', runId),
    list: () => ipcRenderer.invoke('eval:list'),
    export: (runId) => ipcRenderer.invoke('eval:export', runId),
    import: (filePath) => ipcRenderer.invoke('eval:import', filePath),
    subscribe: (runId, callback) => {
      const channel = `eval:updates:${runId}`;
      ipcRenderer.on(channel, (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners(channel);
    },
  },
  
  // Settings methods
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
  },
  
  // API Keys methods (stored in keytar)
  keys: {
    save: (provider, key) => ipcRenderer.invoke('keys:save', provider, key),
    get: (provider) => ipcRenderer.invoke('keys:get', provider),
    test: (provider) => ipcRenderer.invoke('keys:test', provider),
  },
  
  // Cost table methods
  costs: {
    get: (modelRef) => ipcRenderer.invoke('costs:get', modelRef),
    set: (entry) => ipcRenderer.invoke('costs:set', entry),
    getAll: () => ipcRenderer.invoke('costs:getAll'),
  },
});

// TypeScript definitions are in src/window.d.ts

