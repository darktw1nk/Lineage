import { contextBridge, ipcRenderer } from 'electron';
import type { EvaluationConfig, EvaluationRun, ModelRef, ModelCostEntry, AppSettings } from '../src/types/index.js';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Evaluation methods
  eval: {
    create: (config: EvaluationConfig) => ipcRenderer.invoke('eval:create', config),
    start: (runId: string) => ipcRenderer.invoke('eval:start', runId),
    pause: (runId: string) => ipcRenderer.invoke('eval:pause', runId),
    resume: (runId: string) => ipcRenderer.invoke('eval:resume', runId),
    stop: (runId: string) => ipcRenderer.invoke('eval:stop', runId),
    list: () => ipcRenderer.invoke('eval:list'),
    export: (runId: string) => ipcRenderer.invoke('eval:export', runId),
    import: (filePath: string) => ipcRenderer.invoke('eval:import', filePath),
    subscribe: (runId: string, callback: (data: any) => void) => {
      const channel = `eval:updates:${runId}`;
      ipcRenderer.on(channel, (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners(channel);
    },
  },
  
  // Settings methods
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: AppSettings) => ipcRenderer.invoke('settings:set', settings),
  },
  
  // API Keys methods (stored in keytar)
  keys: {
    save: (provider: string, key: string) => ipcRenderer.invoke('keys:save', provider, key),
    get: (provider: string) => ipcRenderer.invoke('keys:get', provider),
    test: (provider: string) => ipcRenderer.invoke('keys:test', provider),
  },
  
  // Cost table methods
  costs: {
    get: (modelRef: ModelRef) => ipcRenderer.invoke('costs:get', modelRef),
    set: (entry: ModelCostEntry) => ipcRenderer.invoke('costs:set', entry),
    getAll: () => ipcRenderer.invoke('costs:getAll'),
  },
});

// Type declarations for TypeScript
export interface ElectronAPI {
  eval: {
    create: (config: EvaluationConfig) => Promise<EvaluationRun>;
    start: (runId: string) => Promise<void>;
    pause: (runId: string) => Promise<void>;
    resume: (runId: string) => Promise<void>;
    stop: (runId: string) => Promise<void>;
    list: () => Promise<EvaluationRun[]>;
    export: (runId: string) => Promise<string>;
    import: (filePath: string) => Promise<EvaluationRun>;
    subscribe: (runId: string, callback: (data: any) => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (settings: AppSettings) => Promise<void>;
  };
  keys: {
    save: (provider: string, key: string) => Promise<void>;
    get: (provider: string) => Promise<string | null>;
    test: (provider: string) => Promise<boolean>;
  };
  costs: {
    get: (modelRef: ModelRef) => Promise<ModelCostEntry | null>;
    set: (entry: ModelCostEntry) => Promise<void>;
    getAll: () => Promise<ModelCostEntry[]>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

