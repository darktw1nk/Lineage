import React, { useState } from 'react';
import { Button } from './ui/button';
import { Pause, Play, Square, Loader2 } from 'lucide-react';
import type { UUID } from '../types';
import { useEvaluationState } from '../hooks/useEvaluationState';

interface FooterProps {
  evaluationId: UUID | null;
}

export function Footer({ evaluationId }: FooterProps) {
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  
  // Pure IPC-driven state - NO POLLING!
  const { evaluation } = useEvaluationState(evaluationId);

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
      setIsResuming(true);
      try {
        await window.electronAPI.eval.resume(evaluation.id);
      } finally {
        setTimeout(() => setIsResuming(false), 1000); // Clear after status updates
      }
    } else {
      setIsPausing(true);
      try {
        await window.electronAPI.eval.pause(evaluation.id);
      } finally {
        setTimeout(() => setIsPausing(false), 1000); // Clear after status updates
      }
    }
  };

  const handleStop = async () => {
    setIsStopping(true);
    try {
      await window.electronAPI.eval.stop(evaluation.id);
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
          disabled={isStopped || isPausing || isResuming}
        >
          {isPausing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Pausing...
            </>
          ) : isResuming ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Resuming...
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
      </div>
    </div>
  );
}

