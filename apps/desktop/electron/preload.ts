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
    delete: (runId) => ipcRenderer.invoke('eval:delete', runId),
    getConfig: (runId) => ipcRenderer.invoke('eval:getConfig', runId),
    estimate: (config) => ipcRenderer.invoke('eval:estimate', config),
    subscribe: (runId, callback) => {
      const channel = `eval:updates:${runId}`;
      const listener = (event, data) => callback(event, data);
      ipcRenderer.on(channel, listener);
      // Return unsubscribe function that removes ONLY this specific listener
      return () => ipcRenderer.removeListener(channel, listener);
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
    setMany: (entries) => ipcRenderer.invoke('costs:setMany', entries),
    getAll: () => ipcRenderer.invoke('costs:getAll'),
  },

  // OpenRouter model discovery
  models: {
    fetchOpenRouter: () => ipcRenderer.invoke('models:fetch-openrouter'),
    syncOpenRouter: () => ipcRenderer.invoke('models:sync-openrouter'),
  },
  
  // Logger methods
  logs: {
    getBuffer: () => ipcRenderer.invoke('logs:getBuffer'),
    subscribe: (callback) => {
      // Remove only OUR listener. removeAllListeners tore down every
      // subscriber's — harmless while LogsPanel is the only one, but it makes
      // the second subscriber silently break the first. eval.subscribe above
      // already does this correctly.
      const handler = (_event: unknown, entry: unknown) => callback(entry as any);
      ipcRenderer.on('log:entry', handler);
      return () => ipcRenderer.removeListener('log:entry', handler);
    },
  },
  
  // System Prompts methods
  systemPrompts: {
    get: () => ipcRenderer.invoke('systemPrompts:get'),
    set: (prompts) => ipcRenderer.invoke('systemPrompts:set', prompts),
  },

  // Plugin methods
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (name, enabled) => ipcRenderer.invoke('plugins:setEnabled', name, enabled),
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  },
  
  // Dev Tools (only available in development)
  dev: {
    createTestEvals: (count: number) => ipcRenderer.invoke('dev:createTestEvals', count),
  },
});

// TypeScript definitions are in src/window.d.ts

