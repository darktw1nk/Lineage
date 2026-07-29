/**
 * Hook to access evaluation data from centralized store
 * Handles initial load from database and IPC subscription
 */

import { useEffect } from 'react';
import type { UUID, EvaluationRun } from '../types';
import { useEvaluationStore } from '../store/evaluationStore';

export function useEvaluation(evaluationId: UUID | null): {
  evaluation: EvaluationRun | null;
  isLoading: boolean;
} {
  const evaluation = useEvaluationStore((state) => 
    evaluationId ? state.evaluations.get(evaluationId) || null : null
  );
  
  const isLoading = useEvaluationStore((state) => 
    evaluationId ? state.loading.has(evaluationId) : false
  );
  
  const setEvaluation = useEvaluationStore((state) => state.setEvaluation);
  const hydrate = useEvaluationStore((state) => state.hydrate);
  const setLoading = useEvaluationStore((state) => state.setLoading);
  const subscribe = useEvaluationStore((state) => state.subscribe);
  const releaseInactive = useEvaluationStore((state) => state.releaseInactive);
  
  useEffect(() => {
    if (!evaluationId) return;
    
    console.log(`[useEvaluation] Setting up for ${evaluationId.slice(0, 8)}`);
    
    // Subscribe to IPC updates FIRST (store handles deduplication)
    subscribe(evaluationId);
    
    // ONLY load from database if evaluation doesn't exist in store yet
    const existingEval = useEvaluationStore.getState().evaluations.get(evaluationId);
    
    if (!existingEval) {
      console.log(`[useEvaluation] No existing state, loading from DB...`);
      
      (async () => {
        setLoading(evaluationId, true);
        
        try {
          // eval:get, not eval:list — list returns summaries with no
          // generations now, and fetching every run to find one was the
          // reason the sidebar poll grew to seconds.
          const eval_ = await window.electronAPI.eval.get(evaluationId);

          if (eval_) {
            console.log(`[useEvaluation] Loaded eval ${evaluationId.slice(0, 8)} from DB, ${eval_.generations.length} generations`);
            // hydrate, not setEvaluation: this read was issued BEFORE the
            // subscription started delivering, so replacing wholesale rewound
            // any node that arrived while it was in flight.
            hydrate(evaluationId, eval_);
          } else {
            console.log(`[useEvaluation] Eval ${evaluationId.slice(0, 8)} not found, creating empty shell`);
            setEvaluation(evaluationId, {
              id: evaluationId,
              configId: '',
              status: 'running',
              startedAt: Date.now(),
              generations: [[]],
              totals: {
                tokensPrompt: 0,
                tokensCompletion: 0,
                usd: 0,
                calls: 0,
              },
              cacheHits: 0,
              version: '1.0',
            });
          }
        } catch (error) {
          console.error(`[useEvaluation] Failed to load eval:`, error);
        } finally {
          setLoading(evaluationId, false);
        }
      })();
    } else {
      console.log(`[useEvaluation] Using existing state (${existingEval.generations.length} generations), skipping DB load`);
    }
    
    // Do NOT unsubscribe THIS evaluation on unmount — other components may
    // still be reading it, and the store owns the subscription lifecycle.
    // But do release the ones nobody is looking at any more: nothing else
    // ever called unsubscribe outside delete, so every run the user clicked
    // stayed resident with its IPC listener for the whole session.
    // Live runs are never released.
    releaseInactive(evaluationId);

    return () => {
      console.log(`[useEvaluation] Component unmounting for ${evaluationId.slice(0, 8)}, but keeping subscription alive`);
    };
  }, [evaluationId, setEvaluation, hydrate, setLoading, subscribe, releaseInactive]);
  
  return { evaluation, isLoading };
}

