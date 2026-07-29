import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Pause, Play, Square, Loader2, Settings2 } from 'lucide-react';
import type { UUID } from '../types';
import { useEvaluation } from '../hooks/useEvaluation';

interface FooterProps {
  evaluationId: UUID | null;
  onShowConfig?: () => void;
}

// Format elapsed time in a human-readable format
function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Format cost with appropriate precision
function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost >= 0.01) return `$${cost.toFixed(4)}`; // Regular format for normal costs
  if (cost >= 0.000001) return `$${cost.toFixed(6)}`; // 6 decimals for very small costs
  // For extremely tiny costs, use scientific notation
  return `$${cost.toExponential(2)}`;
}

/**
 * A stopReason is recorded on EVERY terminal run, including successful ones —
 * an ordinary completion sets 'generations'. Checking it before the status made
 * every finished run read "Stopped: generations", and a run that genuinely hit
 * its quality bar read "Stopped: target". Only the reasons that mean the run
 * was cut short deserve "Stopped".
 */
const CUT_SHORT: Record<string, string> = {
  budget: 'Stopped: budget reached',
  time: 'Stopped: time limit',
  manual: 'Stopped manually',
  error: 'Stopped: error',
  exhausted: 'Stopped: no candidates left',
};

function statusLabel(status: string | undefined, stopReason: string | undefined, isPaused: boolean): string {
  if (stopReason && CUT_SHORT[stopReason]) return CUT_SHORT[stopReason];
  if (status === 'finished') return stopReason === 'target' ? 'Finished (target reached)' : 'Finished';
  if (status === 'pausing') return 'Pausing...';
  if (status === 'stopped') return 'Stopped';
  if (isPaused) return 'Paused';
  return 'Running';
}

export function Footer({ evaluationId, onShowConfig }: FooterProps) {
  const [isStopping, setIsStopping] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // Centralized store - single source of truth!
  const { evaluation } = useEvaluation(evaluationId);

  // Update current time every second for running/pausing evaluations
  // Timer updates only when 'running' or 'pausing', freezes when 'paused'
  useEffect(() => {
    if (!evaluation) return;
    
    // Stop timer for paused, stopped, finished, or when finishedAt is set
    if (evaluation.status === 'paused') return;
    if (evaluation.status === 'stopped') return;
    if (evaluation.status === 'finished') return;
    if (evaluation.finishedAt) return;
    
    // Only run timer for running or pausing
    if (evaluation.status !== 'running' && evaluation.status !== 'pausing') return;
    
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, [evaluation?.status, evaluation?.finishedAt]);

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
  const isPausing = status === 'pausing';
  const isStopped = status === 'stopped' || status === 'finished' || !!evaluation.stopReason;
  
  // Calculate elapsed time (excluding paused time)
  // Backend tracks totalPausedMs and sends it via IPC
  let elapsedMs: number;
  if (evaluation.finishedAt) {
    // Finished - use final time minus total paused
    elapsedMs = (evaluation.finishedAt - evaluation.startedAt) - (evaluation.totalPausedMs || 0);
  } else {
    // Running or paused - calculate wall-clock time minus total paused
    const wallClockMs = currentTime - evaluation.startedAt;
    elapsedMs = wallClockMs - (evaluation.totalPausedMs || 0);
  }
  const elapsedTime = formatElapsedTime(elapsedMs);
  
  const handlePauseResume = async () => {
    if (isPaused) {
      try {
        await window.electronAPI.eval.resume(evaluation.id);
      } catch (error: any) {
        // These went to the console only, which the Logs panel hides by
        // default — the button simply appeared not to work.
        toast.error(`Could not resume: ${error?.message ?? error}`);
      }
    } else {
      try {
        await window.electronAPI.eval.pause(evaluation.id);
      } catch (error: any) {
        toast.error(`Could not pause: ${error?.message ?? error}`);
      }
    }
  };

  const handleStop = async () => {
    setIsStopping(true);
    try {
      await window.electronAPI.eval.stop(evaluation.id);
    } catch (error: any) {
      // handleStop had no catch at all: a rejected eval:stop was an unhandled
      // promise rejection and the user was told nothing.
      toast.error(`Could not stop the run: ${error?.message ?? error}`);
    } finally {
      setTimeout(() => setIsStopping(false), 1000); // Clear after status updates
    }
  };

  return (
    <div className="flex h-16 items-center justify-between border-t bg-card px-6">
      {/* Status */}
      <div className="flex items-center space-x-6">
        <div>
          <div className="text-xs text-muted-foreground">Status</div>
          <div className="text-sm font-medium">
            {statusLabel(status, evaluation.stopReason, isPaused)}
          </div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Generation</div>
          <div className="text-sm font-medium">{currentGeneration}</div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Elapsed</div>
          <div className="text-sm font-medium">{elapsedTime}</div>
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
            {formatCost(evaluation.totals.usd)}
          </div>
        </div>
        
        <div>
          <div className="text-xs text-muted-foreground">Cache Hits</div>
          <div className="text-sm font-medium">{evaluation.cacheHits}</div>
        </div>

        {evaluation.holdout?.seed && evaluation.holdout?.champion && (
          <div>
            <div className="text-xs text-muted-foreground">Holdout</div>
            <div className="text-sm font-medium">
              {evaluation.holdout.seed.score.toFixed(2)} → {evaluation.holdout.champion.score.toFixed(2)}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex space-x-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handlePauseResume}
          disabled={isStopped || isPausing}
        >
          {isPausing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Pausing...
            </>
          ) : isPaused ? (
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
          disabled={isStopped || isStopping}
        >
          {isStopping ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Stopping...
            </>
          ) : (
            <>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </>
          )}
        </Button>
        
        {onShowConfig && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onShowConfig}
            title="View Evaluation Config"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

