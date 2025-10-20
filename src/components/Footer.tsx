import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/button';
import { Pause, Play, Square } from 'lucide-react';
import type { UUID, EvaluationRun } from '../types';

interface FooterProps {
  evaluationId: UUID | null;
}

export function Footer({ evaluationId }: FooterProps) {
  const { data: evaluation } = useQuery<EvaluationRun>({
    queryKey: ['evaluation', evaluationId],
    enabled: !!evaluationId,
    queryFn: async () => {
      const evals = await window.electronAPI.eval.list();
      return evals.find(e => e.id === evaluationId) || null;
    },
    refetchInterval: 1000,
  });

  if (!evaluation) {
    return (
      <div className="flex h-16 items-center justify-between border-t bg-card px-6">
        <div className="text-sm text-muted-foreground">No evaluation selected</div>
      </div>
    );
  }

  const currentGeneration = evaluation.generations.length;
  const status = evaluation.status || (evaluation.finishedAt ? 'stopped' : 'running');
  const isPaused = status === 'paused';
  const isStopped = status === 'stopped' || !!evaluation.stopReason;
  
  const handlePauseResume = async () => {
    if (isPaused) {
      await window.electronAPI.eval.resume(evaluation.id);
    } else {
      await window.electronAPI.eval.pause(evaluation.id);
    }
  };

  const handleStop = async () => {
    await window.electronAPI.eval.stop(evaluation.id);
  };

  return (
    <div className="flex h-16 items-center justify-between border-t bg-card px-6">
      {/* Status */}
      <div className="flex items-center space-x-6">
        <div>
          <div className="text-xs text-muted-foreground">Status</div>
          <div className="text-sm font-medium">
            {evaluation.stopReason
              ? `Stopped: ${evaluation.stopReason}`
              : isPaused
              ? 'Paused'
              : 'Running'}
          </div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Generation</div>
          <div className="text-sm font-medium">{currentGeneration}</div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Tokens</div>
          <div className="text-sm font-medium">
            {(evaluation.totals.tokensPrompt + evaluation.totals.tokensCompletion).toLocaleString()}
          </div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Spend</div>
          <div className="text-sm font-medium">
            ${evaluation.totals.usd.toFixed(4)}
          </div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Cache Hits</div>
          <div className="text-sm font-medium">{evaluation.cacheHits}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex space-x-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handlePauseResume}
          disabled={isStopped}
        >
          {isPaused ? (
            <>
              <Play className="mr-2 h-4 w-4" />
              Resume
            </>
          ) : (
            <>
              <Pause className="mr-2 h-4 w-4" />
              Pause
            </>
          )}
        </Button>
        
        <Button
          size="sm"
          variant="destructive"
          onClick={handleStop}
          disabled={isStopped}
        >
          <Square className="mr-2 h-4 w-4" />
          Stop
        </Button>
      </div>
    </div>
  );
}

