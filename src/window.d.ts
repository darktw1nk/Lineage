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
    list: () => Promise<EvaluationRun[]>;
    export: (runId: string) => Promise<string>;
    import: (filePath: string) => Promise<EvaluationRun>;
    delete: (runId: string) => Promise<void>;
    getConfig: (runId: string) => Promise<EvaluationConfig | null>;
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
    debug: () => Promise<{ allKeys: string[]; allData: any }>;
  };
  costs: {
    get: (modelRef: ModelRef) => Promise<ModelCostEntry | null>;
    set: (entry: ModelCostEntry) => Promise<void>;
    getAll: () => Promise<ModelCostEntry[]>;
  };
  logs: {
    getBuffer: () => Promise<LogEntry[]>;
    subscribe: (callback: (entry: LogEntry) => void) => () => void;
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

