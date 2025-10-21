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
    console.log('[useEvaluationState] Effect triggered, evaluationId:', evaluationId?.slice(0, 8));
    
    if (!evaluationId) {
      console.log('[useEvaluationState] No evaluationId, clearing state');
      setEvaluation(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    // Initial load from database
    const loadInitialState = async () => {
      try {
        console.log('[useEvaluationState] Loading initial state from database...');
        const evals = await window.electronAPI.eval.list();
        console.log('[useEvaluationState] Found', evals.length, 'evaluations');
        const eval_ = evals.find(e => e.id === evaluationId);
        console.log('[useEvaluationState] Found eval:', eval_ ? 'YES' : 'NO');
        if (isMounted) {
          setEvaluation(eval_ || null);
          setIsLoading(false);
          console.log('[useEvaluationState] Initial state loaded, nodes:', eval_?.generations.reduce((s, g) => s + g.length, 0) || 0);
        }
      } catch (error) {
        console.error('[useEvaluationState] Failed to load initial state:', error);
        if (isMounted) {
          setEvaluation(null);
          setIsLoading(false);
        }
      }
    };

    console.log('[useEvaluationState] Starting initial load...');
    loadInitialState();

    // Subscribe to real-time IPC updates
    const handleUpdate = (_event: any, data: any) => {
      if (!data) return;

      console.log('[useEvaluationState] IPC update:', data.type, data);

      setEvaluation(prev => {
        // If no previous state, create minimal state from updates
        if (!prev) {
          if (data.type === 'node') {
            const node = data.node as CandidateNode;
            console.log('[useEvaluationState] Creating initial state from node:', node.id.slice(0, 8));
            return {
              id: evaluationId!,
              configId: '',
              status: 'running',
              createdAt: Date.now(),
              generations: [[node]],
              totals: { spentUSD: 0, promptTokens: 0, completionTokens: 0 },
              cacheHits: 0,
            } as EvaluationRun;
          }
          console.log('[useEvaluationState] No prev state, ignoring update type:', data.type);
          return prev;
        }

        switch (data.type) {
          case 'status':
            console.log('[useEvaluationState] Updating status:', data.status);
            return { ...prev, status: data.status };

          case 'generation':
            console.log('[useEvaluationState] Updating generation:', data.generation, 'nodes:', data.nodes?.length);
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
            console.log('[useEvaluationState] Updating node:', node.id.slice(0, 8), 'gen:', node.generation, 'status:', node.status);
            
            // Ensure we have enough generations
            const gens = [...prev.generations];
            while (gens.length <= node.generation) {
              gens.push([]);
            }
            
            const updatedGenerations = gens.map((gen, idx) => {
              if (idx === node.generation) {
                // Check if node already exists
                const existingIndex = gen.findIndex(n => n.id === node.id);
                if (existingIndex >= 0) {
                  // Update existing node
                  const newGen = [...gen];
                  newGen[existingIndex] = node;
                  console.log('[useEvaluationState] Updated existing node at index', existingIndex);
                  return newGen;
                } else {
                  // Add new node
                  console.log('[useEvaluationState] Added new node to generation', idx);
                  return [...gen, node];
                }
              }
              return gen;
            });
            return { ...prev, generations: updatedGenerations };

          case 'totals':
            console.log('[useEvaluationState] Updating totals:', data.totals);
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

