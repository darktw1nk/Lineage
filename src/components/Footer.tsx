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

  const isRunning = !evaluation.finishedAt;
  const currentGeneration = evaluation.generations.length;

  const [isPaused, setIsPaused] = React.useState(false);
  
  const handlePauseResume = async () => {
    if (!isPaused) {
      await window.electronAPI.eval.pause(evaluation.id);
      setIsPaused(true);
    } else {
      await window.electronAPI.eval.resume(evaluation.id);
      setIsPaused(false);
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
          disabled={!!evaluation.stopReason}
        >
          {isRunning ? (
            <>
              <Pause className="mr-2 h-4 w-4" />
              Pause
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              Resume
            </>
          )}
        </Button>
        
        <Button
          size="sm"
          variant="destructive"
          onClick={handleStop}
          disabled={!!evaluation.stopReason}
        >
          <Square className="mr-2 h-4 w-4" />
          Stop
        </Button>
      </div>
    </div>
  );
}

