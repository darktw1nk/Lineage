import { useState, useEffect } from 'react';
import type { UUID, EvaluationRun, CandidateNode } from '../types';

/**
 * Pure IPC-driven evaluation state.
 * NO POLLING. NO DATABASE QUERIES.
 * Updates ONLY from real-time IPC events.
 */
export function useEvaluationState(evaluationId: UUID | null) {
  const [evaluation, setEvaluation] = useState<EvaluationRun | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!evaluationId) {
      setEvaluation(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    // Initial load from database
    const loadInitialState = async () => {
      try {
        const evals = await window.electronAPI.eval.list();
        const eval_ = evals.find(e => e.id === evaluationId);
        if (isMounted) {
          setEvaluation(eval_ || null);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('[useEvaluationState] Failed to load initial state:', error);
        if (isMounted) {
          setEvaluation(null);
          setIsLoading(false);
        }
      }
    };

    loadInitialState();

    // Subscribe to real-time IPC updates
    const handleUpdate = (_event: any, data: any) => {
      if (!data) return;

      console.log('[useEvaluationState] IPC update:', data.type);

      setEvaluation(prev => {
        if (!prev) return prev;

        switch (data.type) {
          case 'status':
            return { ...prev, status: data.status };

          case 'generation':
            // New generation created
            const newGenerations = [...prev.generations];
            if (data.generation >= newGenerations.length) {
              // Add new generation
              newGenerations.push(data.nodes || []);
            } else {
              // Update existing generation
              newGenerations[data.generation] = data.nodes || [];
            }
            return { ...prev, generations: newGenerations };

          case 'node':
            // Node created or updated - update it in its generation
            const node = data.node as CandidateNode;
            const updatedGenerations = prev.generations.map((gen, idx) => {
              if (idx === node.generation) {
                // Check if node already exists
                const existingIndex = gen.findIndex(n => n.id === node.id);
                if (existingIndex >= 0) {
                  // Update existing node
                  const newGen = [...gen];
                  newGen[existingIndex] = node;
                  return newGen;
                } else {
                  // Add new node
                  return [...gen, node];
                }
              }
              return gen;
            });
            return { ...prev, generations: updatedGenerations };

          case 'totals':
            return { ...prev, totals: data.totals, cacheHits: data.cacheHits };

          default:
            return prev;
        }
      });
    };

    const unsubscribe = window.electronAPI.eval.subscribe(evaluationId, handleUpdate);

    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [evaluationId]);

  return { evaluation, isLoading };
}

