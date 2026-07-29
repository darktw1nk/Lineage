import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { Plus, Settings, Download, Upload, Trash2, FileText, Code2, Play } from 'lucide-react';
import type { UUID, EvaluationRun, EvaluationConfig } from '../types';
import { useEvaluationStore } from '../store/evaluationStore';
import { toast } from 'sonner';

// Format elapsed time in a compact format for sidebar
function formatElapsedTimeCompact(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${seconds}s`;
  }
}

interface LeftSidebarProps {
  onNewEvaluation: () => void;
  onImportConfig: (config: Partial<EvaluationConfig>) => void;
  onSettings: () => void;
  onSystemPrompts: () => void;
  onLogs: () => void;
  onSelectEvaluation: (id: UUID) => void;
  selectedEvaluationId: UUID | null;
}

export function LeftSidebar({
  onNewEvaluation,
  onImportConfig,
  onSettings,
  onSystemPrompts,
  onLogs,
  onSelectEvaluation,
  selectedEvaluationId,
}: LeftSidebarProps) {
  const queryClient = useQueryClient();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const frozenTimesRef = useRef<Map<string, number>>(new Map());
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('leftSidebarWidth');
    return saved ? parseInt(saved, 10) : 256; // 256px = w-64
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  
  // Update current time every second for running evaluations
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const newWidth = e.clientX;
      // Min width: 200px, Max width: 500px
      const clampedWidth = Math.max(200, Math.min(500, newWidth));
      setWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem('leftSidebarWidth', width.toString());
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // Prevent text selection and show resize cursor globally while dragging
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, width]);
  
  // Get evaluations from database (for list of all evaluations)
  const { data: dbEvaluations = [] } = useQuery<Array<EvaluationRun & { configName?: string; interrupted?: boolean }>>({
    queryKey: ['evaluations'],
    queryFn: async () => {
      return await window.electronAPI.eval.list();
    },
    refetchInterval: 2000,
  });
  
  // Get real-time data from Zustand store
  const storeEvaluations = useEvaluationStore((state) => state.evaluations);
  
  // Merge: use store data for running evaluations, DB data for others.
  // `interrupted` must ALWAYS come from the fresh DB row: the store copy is a
  // snapshot that can carry a stale flag (e.g. captured in the window between
  // run creation and start) and would badge a live run as interrupted forever.
  const evaluations = dbEvaluations.map(dbEval => {
    const liveEval = storeEvaluations.get(dbEval.id);
    return liveEval
      ? { ...liveEval, interrupted: dbEval.interrupted }
      : dbEval;
  });
  
  const exportMutation = useMutation({
    mutationFn: async (runId: string) => {
      return await window.electronAPI.eval.export(runId);
    },
    onSuccess: (filePath) => {
      alert(`Exported to: ${filePath}`);
    },
    onError: (error: any) => {
      alert(`Export failed: ${error.message}`);
    },
  });
  
  const resumeMutation = useMutation({
    mutationFn: async (runId: string) => {
      // Subscribe + select BEFORE starting (same "CRITICAL" ordering the create
      // flow uses): the engine replays checkpointed state immediately on start,
      // and an unsubscribed renderer would miss the replay.
      useEvaluationStore.getState().subscribe(runId as UUID);
      onSelectEvaluation(runId as UUID);
      await window.electronAPI.eval.start(runId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error: any) => {
      // A stale badge can race an already-live run — that's a no-op, not an error
      if (String(error?.message ?? '').includes('already running')) {
        queryClient.invalidateQueries({ queryKey: ['evaluations'] });
        return;
      }
      toast.error(`Resume failed: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (runId: string) => {
      return await window.electronAPI.eval.delete(runId);
    },
    onSuccess: (_, deletedId) => {
      // Tear down the store's IPC subscription and drop the cached graph.
      // Nothing ever called unsubscribe, so a deleted run kept its per-run IPC
      // channel open and its full node graph in memory for the rest of the
      // session — and late events for it still mutated the store.
      useEvaluationStore.getState().unsubscribe(deletedId);
      // Clear selection if deleted evaluation was selected
      if (selectedEvaluationId === deletedId) {
        onSelectEvaluation(null as any);
      }
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error: any) => {
      // A non-Error rejection (several handlers reject with a raw sql.js
      // string) made this read "Delete failed: undefined".
      alert(`Delete failed: ${error?.message ?? String(error)}`);
    },
  });

  // Export evaluation config to JSON file
  const handleExportConfig = async (evaluationId: UUID) => {
    try {
      const config = await window.electronAPI.eval.getConfig(evaluationId);
      if (!config) {
        toast.error('Config not found');
        return;
      }

      // Create JSON blob
      const json = JSON.stringify(config, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = `${config.name || 'evaluation'}-config.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('Config exported successfully');
    } catch (error) {
      toast.error('Failed to export config');
      console.error(error);
    }
  };

  // Import evaluation config from JSON file
  const handleImportConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      try {
        const file = e.target.files[0];
        if (!file) return;

        const text = await file.text();
        const parsed = JSON.parse(text);

        // A full exported RUN ({ run, config, rawBlobs }) is what the "Export
        // Results" button writes, and this importer only ever accepted a bare
        // config — so an exported run could never be read back in. eval:import
        // existed and was wired through preload, with no caller anywhere.
        if (parsed?.run && parsed?.config) {
          const filePath = (file as File & { path?: string }).path;
          if (!filePath) {
            toast.error('Could not read that file’s path — try File › Import again');
            return;
          }
          const imported = await window.electronAPI.eval.import(filePath);
          queryClient.invalidateQueries({ queryKey: ['evaluations'] });
          onSelectEvaluation(imported.id as UUID);
          toast.success('Run imported');
          return;
        }

        // Validate it's a config (basic check)
        if (!parsed.selection || !parsed.operators || !parsed.population) {
          toast.error('Not a PromptEngine config or exported run');
          return;
        }

        // Open modal with imported config
        onImportConfig(parsed);
        toast.success('Config imported successfully');
      } catch (error) {
        toast.error('Failed to import config');
        console.error(error);
      }
    };
    input.click();
  };

  return (
    <div 
      ref={panelRef}
      className="relative flex h-full flex-col border-r bg-card"
      style={{ width: `${width}px` }}
    >
      {/* Resize Handle */}
      <div
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors z-10"
        onMouseDown={() => setIsResizing(true)}
      />
      
      {/* Logo */}
      <div className="p-4">
        <h1 className="text-xl font-bold">PromptEngine.AI</h1>
      </div>

      {/* New Evaluation Buttons */}
      <div className="px-4 pb-4 space-y-2">
        <Button onClick={onNewEvaluation} className="w-full">
          <Plus className="mr-2 h-4 w-4" />
          New Evaluation
        </Button>
        <Button onClick={handleImportConfig} variant="outline" className="w-full">
          <Upload className="mr-2 h-4 w-4" />
          Import Config
        </Button>
      </div>

      {/* Evaluations List */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="mb-2 px-2 text-xs font-semibold text-muted-foreground">
          EVALUATIONS
        </div>
        {evaluations.map((evaluation) => {
          const bestScore = getBestScore(evaluation);
          const status = getStatus(evaluation);
          
          // Calculate elapsed time (excluding paused time)
          let elapsedMs: number;
          if (evaluation.finishedAt) {
            // Finished - use final time (FROZEN)
            elapsedMs = (evaluation.finishedAt - evaluation.startedAt) - (evaluation.totalPausedMs || 0);
            // Clear frozen time
            frozenTimesRef.current.delete(evaluation.id);
          } else if (status === 'paused' && evaluation.pausedAt) {
            // Currently paused - freeze time
            const currentPauseDuration = currentTime - evaluation.pausedAt;
            const totalPaused = (evaluation.totalPausedMs || 0) + currentPauseDuration;
            const wallClockMs = currentTime - evaluation.startedAt;
            elapsedMs = wallClockMs - totalPaused;
          } else if (status === 'running' || status === 'pausing') {
            // Running or pausing - calculate live time
            const wallClockMs = currentTime - evaluation.startedAt;
            elapsedMs = wallClockMs - (evaluation.totalPausedMs || 0);
            // Clear frozen time
            frozenTimesRef.current.delete(evaluation.id);
          } else {
            // Stopped, finished, or other - use frozen time or capture it now
            if (frozenTimesRef.current.has(evaluation.id)) {
              elapsedMs = frozenTimesRef.current.get(evaluation.id)!;
            } else {
              const wallClockMs = currentTime - evaluation.startedAt;
              elapsedMs = wallClockMs - (evaluation.totalPausedMs || 0);
              frozenTimesRef.current.set(evaluation.id, elapsedMs);
            }
          }
          const elapsedTime = formatElapsedTimeCompact(elapsedMs);
          
          return (
            <button
              key={evaluation.id}
              onClick={() => onSelectEvaluation(evaluation.id)}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                selectedEvaluationId === evaluation.id
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-accent'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="truncate font-medium">{getEvaluationName(evaluation)}</span>
                <div className="flex items-center gap-1">
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExportConfig(evaluation.id);
                    }}
                    className="p-1 hover:bg-accent rounded cursor-pointer inline-flex"
                    title="Export Config"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        handleExportConfig(evaluation.id);
                      }
                    }}
                  >
                    <FileText className="h-3 w-3" />
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      exportMutation.mutate(evaluation.id);
                    }}
                    className="p-1 hover:bg-accent rounded cursor-pointer inline-flex"
                    title="Export Results"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        exportMutation.mutate(evaluation.id);
                      }
                    }}
                  >
                    <Download className="h-3 w-3" />
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete evaluation ${evaluation.id.slice(0, 8)}?`)) {
                        deleteMutation.mutate(evaluation.id);
                      }
                    }}
                    className="p-1 hover:bg-destructive hover:text-destructive-foreground rounded cursor-pointer inline-flex"
                    title="Delete"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        if (confirm(`Delete evaluation ${evaluation.id.slice(0, 8)}?`)) {
                          deleteMutation.mutate(evaluation.id);
                        }
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                  {evaluation.interrupted ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">
                      interrupted
                    </span>
                  ) : (
                    <span className={`text-xs ${getStatusColor(status)}`}>
                      {status}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs opacity-70">
                {bestScore !== null && (
                  <span>Best: {bestScore.toFixed(2)}</span>
                )}
                {evaluation.interrupted && !resumeMutation.isPending && (
                  <span
                    className="inline-flex items-center gap-1 text-amber-600 hover:text-amber-500 cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      resumeMutation.mutate(evaluation.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        resumeMutation.mutate(evaluation.id);
                      }
                    }}
                  >
                    <Play className="h-3 w-3" />
                    Resume
                  </span>
                )}
                <span className="ml-auto">{elapsedTime}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Bottom Buttons */}
      <div className="border-t p-4 space-y-2">
        <Button onClick={onSystemPrompts} variant="outline" className="w-full">
          <Code2 className="mr-2 h-4 w-4" />
          System Prompts
        </Button>
        <Button onClick={onSettings} variant="outline" className="w-full">
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </Button>
        <Button onClick={onLogs} variant="outline" className="w-full">
          <FileText className="mr-2 h-4 w-4" />
          Logs
        </Button>
      </div>
    </div>
  );
}

function getEvaluationName(evaluation: EvaluationRun): string {
  // Try to get config name from evaluation (added by backend)
  const configName = (evaluation as any).configName;
  if (configName) {
    return configName;
  }
  // Fallback to ID
  return `Eval ${evaluation.id.slice(0, 8)}`;
}

function getBestScore(evaluation: EvaluationRun & { bestScore?: number | null }): number | null {
  // eval:list precomputes this in the main process and ships no generations,
  // so the sidebar no longer receives (or scans) every node of every run.
  if (evaluation.bestScore !== undefined) return evaluation.bestScore;
  let best = -Infinity;
  for (const generation of evaluation.generations ?? []) {
    for (const node of generation) {
      if (node.metrics?.fitness !== undefined && node.metrics.fitness > best) {
        best = node.metrics.fitness;
      }
    }
  }
  return best > -Infinity ? best : null;
}

function getStatus(evaluation: EvaluationRun): string {
  // Check explicit status first (running, pausing, paused, stopped)
  if (evaluation.status) {
    if (evaluation.status === 'stopped' && evaluation.stopReason) {
      return evaluation.stopReason;
    }
    return evaluation.status;
  }
  
  // Fallback: check if finished
  if (evaluation.finishedAt) {
    return evaluation.stopReason ?? 'finished';
  }
  
  return 'running';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'pausing':
      return 'text-orange-500';
    case 'paused':
      return 'text-yellow-500';
    case 'stopped':
      return 'text-gray-500';
    case 'finished':
    case 'target':
      return 'text-green-500';
    case 'budget':
    case 'time':
      return 'text-purple-500';
    case 'error':
      return 'text-red-500';
    case 'manual':
      return 'text-orange-500';
    default:
      return 'text-muted-foreground';
  }
}

