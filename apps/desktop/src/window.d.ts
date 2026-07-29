import type { EvaluationConfig, EvaluationRun, ModelRef, ModelCostEntry, AppSettings } from './types';

export interface LogEntry {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  args: any[];
}

export interface SystemPrompts {
  mutationStrategies: string; // JSON string
  mutationProposalPrompt: string;
  mutationApplyPrompt: string;
  crossoverPrompt: string;
  metapromptWithFailuresPrompt: string;
  metapromptWithoutFailuresPrompt: string;
  metapromptApplyPrompt: string;
  llmGradingPrompt: string;
  safetyGuardrailPrompt: string;
}

export interface ElectronAPI {
  eval: {
    create: (config: EvaluationConfig) => Promise<EvaluationRun>;
    start: (runId: string) => Promise<void>;
    pause: (runId: string) => Promise<void>;
    resume: (runId: string) => Promise<void>;
    stop: (runId: string) => Promise<void>;
    /**
     * SUMMARIES for the sidebar: scalars + `bestScore`. `generations` is always
     * empty — polling the full runs every 2s cost more than the poll interval
     * once a couple of large runs existed. Use `get` for a whole run.
     */
    list: () => Promise<Array<EvaluationRun & {
      configName?: string; interrupted?: boolean;
      bestScore?: number | null; generationCount?: number; nodeCount?: number;
    }>>;
    get: (runId: string) => Promise<(EvaluationRun & { configName?: string; interrupted?: boolean }) | null>;
    /** Absolute path of a dropped File — webUtils on Electron 32+, File.path before. */
    pathForFile: (file: File) => string | null;
    /** Resolves to the written path, or null when the user cancels the save dialog. */
    export: (runId: string) => Promise<string | null>;
    import: (filePath: string) => Promise<EvaluationRun>;
    delete: (runId: string) => Promise<void>;
    getConfig: (runId: string) => Promise<EvaluationConfig | null>;
    estimate: (config: EvaluationConfig) => Promise<import('@promptengine/core').CostEstimate | null>;
    subscribe: (runId: string, callback: (event: any, data: any) => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (settings: AppSettings) => Promise<void>;
  };
  keys: {
    save: (provider: string, key: string) => Promise<void>;
    get: (provider: string) => Promise<string | null>;
    test: (provider: string) => Promise<boolean>;
    debug: () => Promise<{ allKeys: string[]; allData: any }>;
  };
  costs: {
    get: (modelRef: ModelRef) => Promise<ModelCostEntry | null>;
    set: (entry: ModelCostEntry) => Promise<void>;
    /** Write many rows in one transaction — Save used to loop `set` per row. */
    setMany: (entries: ModelCostEntry[]) => Promise<void>;
    getAll: () => Promise<ModelCostEntry[]>;
  };
  models: {
    fetchOpenRouter: () => Promise<Array<{ id: string; name: string; promptUSDper1k: number; completionUSDper1k: number }>>;
    syncOpenRouter: () => Promise<{ count: number }>;
  };
  logs: {
    getBuffer: () => Promise<LogEntry[]>;
    subscribe: (callback: (entry: LogEntry) => void) => () => void;
  };
  plugins: {
    list: () => Promise<{ manifests: Array<{ name: string; version?: string; source: string; operators: string[]; providers: string[]; error?: string }>; disabled: string[] }>;
    setEnabled: (name: string, enabled: boolean) => Promise<string[]>;
    openFolder: () => Promise<boolean>;
  };
  systemPrompts: {
    get: () => Promise<SystemPrompts | null>;
    set: (prompts: SystemPrompts) => Promise<void>;
  };
  dev: {
    createTestEvals: (count: number) => Promise<string[]>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

