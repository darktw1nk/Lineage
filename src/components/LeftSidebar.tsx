import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/button';
import { Plus, Settings, Download, Upload } from 'lucide-react';
import type { UUID, EvaluationRun } from '../types';

interface LeftSidebarProps {
  onNewEvaluation: () => void;
  onSettings: () => void;
  onSelectEvaluation: (id: UUID) => void;
  selectedEvaluationId: UUID | null;
}

export function LeftSidebar({
  onNewEvaluation,
  onSettings,
  onSelectEvaluation,
  selectedEvaluationId,
}: LeftSidebarProps) {
  const queryClient = useQueryClient();
  
  const { data: evaluations = [] } = useQuery<EvaluationRun[]>({
    queryKey: ['evaluations'],
    queryFn: async () => {
      return await window.electronAPI.eval.list();
    },
    refetchInterval: 5000,
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
                <span className="truncate font-medium">Eval {evaluation.id.slice(0, 8)}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      exportMutation.mutate(evaluation.id);
                    }}
                    className="p-1 hover:bg-accent rounded"
                    title="Export"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                  <span className={`text-xs ${getStatusColor(status)}`}>
                    {status}
                  </span>
                </div>
              </div>
              {bestScore !== null && (
                <div className="mt-1 text-xs opacity-70">
                  Best: {bestScore.toFixed(2)}
                </div>
              )}
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
      </div>
    </div>
  );
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
  if (evaluation.finishedAt) {
    return evaluation.stopReason ?? 'finished';
  }
  return 'running';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'paused':
      return 'text-yellow-500';
    case 'finished':
    case 'target':
      return 'text-green-500';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-muted-foreground';
  }
}

