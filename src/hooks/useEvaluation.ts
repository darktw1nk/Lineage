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
  const setLoading = useEvaluationStore((state) => state.setLoading);
  const subscribe = useEvaluationStore((state) => state.subscribe);
  const unsubscribe = useEvaluationStore((state) => state.unsubscribe);
  
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
          const evals = await window.electronAPI.eval.list();
          const eval_ = evals.find(e => e.id === evaluationId);
          
          if (eval_) {
            console.log(`[useEvaluation] Loaded eval ${evaluationId.slice(0, 8)} from DB, ${eval_.generations.length} generations`);
            setEvaluation(evaluationId, eval_);
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
    
    // Cleanup: DO NOT unsubscribe! Other components may still be using this evaluation
    // Store manages subscription lifecycle
    return () => {
      console.log(`[useEvaluation] Component unmounting for ${evaluationId.slice(0, 8)}, but keeping subscription alive`);
    };
  }, [evaluationId, setEvaluation, setLoading, subscribe]);
  
  return { evaluation, isLoading };
}

