import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { Plus, Settings, Download, Upload, Trash2, FileText } from 'lucide-react';
import type { UUID, EvaluationRun } from '../types';
import { useEvaluationStore } from '../store/evaluationStore';

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
  onSettings: () => void;
  onLogs: () => void;
  onSelectEvaluation: (id: UUID) => void;
  selectedEvaluationId: UUID | null;
}

export function LeftSidebar({
  onNewEvaluation,
  onSettings,
  onLogs,
  onSelectEvaluation,
  selectedEvaluationId,
}: LeftSidebarProps) {
  const queryClient = useQueryClient();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const frozenTimesRef = useRef<Map<string, number>>(new Map());
  
  // Update current time every second for running evaluations
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);
  
  // Get evaluations from database (for list of all evaluations)
  const { data: dbEvaluations = [] } = useQuery<EvaluationRun[]>({
    queryKey: ['evaluations'],
    queryFn: async () => {
      return await window.electronAPI.eval.list();
    },
    refetchInterval: 2000,
  });
  
  // Get real-time data from Zustand store
  const storeEvaluations = useEvaluationStore((state) => state.evaluations);
  
  // Merge: use store data for running evaluations, DB data for others
  const evaluations = dbEvaluations.map(dbEval => {
    const liveEval = storeEvaluations.get(dbEval.id);
    // If evaluation is in store (active/subscribed), use live data
    return liveEval || dbEval;
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
  
  const importMutation = useMutation({
    mutationFn: async () => {
      // This will trigger file dialog in main process
      const filePath = prompt('Enter path to JSON file (or we need file picker):');
      if (!filePath) throw new Error('No file selected');
      return await window.electronAPI.eval.import(filePath);
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
      onSelectEvaluation(run.id);
      alert('Import successful!');
    },
    onError: (error: any) => {
      alert(`Import failed: ${error.message}`);
    },
  });
  
  const deleteMutation = useMutation({
    mutationFn: async (runId: string) => {
      return await window.electronAPI.eval.delete(runId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error: any) => {
      alert(`Delete failed: ${error.message}`);
    },
  });

  return (
    <div className="flex h-full w-64 flex-col border-r bg-card">
      {/* Logo */}
      <div className="p-4">
        <h1 className="text-xl font-bold">Prompt Evolution</h1>
      </div>

      {/* New Evaluation Button */}
      <div className="px-4 pb-4">
        <Button onClick={onNewEvaluation} className="w-full">
          <Plus className="mr-2 h-4 w-4" />
          New Evaluation
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
                      exportMutation.mutate(evaluation.id);
                    }}
                    className="p-1 hover:bg-accent rounded cursor-pointer inline-flex"
                    title="Export"
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
                  <span className={`text-xs ${getStatusColor(status)}`}>
                    {status}
                  </span>
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs opacity-70">
                {bestScore !== null && (
                  <span>Best: {bestScore.toFixed(2)}</span>
                )}
                <span className="ml-auto">{elapsedTime}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Settings and Import Button */}
      <div className="border-t p-4 space-y-2">
        <Button onClick={() => importMutation.mutate()} variant="outline" className="w-full" size="sm">
          <Upload className="mr-2 h-4 w-4" />
          Import
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
  console.log(`[LeftSidebar] Eval ${evaluation.id.slice(0, 8)}: configName =`, configName);
  if (configName) {
    return configName;
  }
  // Fallback to ID
  return `Eval ${evaluation.id.slice(0, 8)}`;
}

function getBestScore(evaluation: EvaluationRun): number | null {
  let best = -Infinity;
  for (const generation of evaluation.generations) {
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

