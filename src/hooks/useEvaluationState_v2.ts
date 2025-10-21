/**
 * useEvaluationState - V2 Complete Rewrite
 * 
 * Pure IPC-driven evaluation state management
 * Clean separation of node_created vs node_updated
 * No race conditions, no polling
 */

import { useState, useEffect } from 'react';
import type { UUID, EvaluationRun, CandidateNode } from '../types';

export function useEvaluationState(evaluationId: UUID | null) {
  const [evaluation, setEvaluation] = useState<EvaluationRun | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    console.log('[useEvalState_v2] Effect triggered, evalId:', evaluationId?.slice(0, 8));
    
    if (!evaluationId) {
      console.log('[useEvalState_v2] No evaluationId, clearing state');
      setEvaluation(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    // Load initial state from database
    const loadInitialState = async () => {
      try {
        console.log('[useEvalState_v2] Loading initial state...');
        const evals = await window.electronAPI.eval.list();
        const eval_ = evals.find(e => e.id === evaluationId);
        
        if (isMounted) {
          if (eval_) {
            console.log('[useEvalState_v2] Loaded existing eval:', eval_.id.slice(0, 8));
            setEvaluation(eval_);
          } else {
            console.log('[useEvalState_v2] No existing eval, creating empty shell');
            setEvaluation(createEmptyEvaluation(evaluationId));
          }
          setIsLoading(false);
        }
      } catch (error) {
        console.error('[useEvalState_v2] Failed to load initial state:', error);
        if (isMounted) {
          setEvaluation(createEmptyEvaluation(evaluationId));
          setIsLoading(false);
        }
      }
    };

    loadInitialState();

    // Subscribe to IPC updates
    console.log('[useEvalState_v2] Setting up IPC subscription...');
    
    const handleUpdate = (_event: any, data: any) => {
      if (!data || !data.type) {
        console.warn('[useEvalState_v2] Received invalid data:', data);
        return;
      }

      console.log('[useEvalState_v2] IPC update:', data.type);

      setEvaluation(prev => {
        if (!prev) {
          console.warn('[useEvalState_v2] No prev state, ignoring update:', data.type);
          return prev;
        }

        switch (data.type) {
          case 'status':
            console.log('[useEvalState_v2] Status update:', data.status);
            return { ...prev, status: data.status };

          case 'node_created':
            console.log('[useEvalState_v2] Node created:', data.node.id.slice(0, 8));
            return addNode(prev, data.node);

          case 'node_updated':
            console.log('[useEvalState_v2] Node updated:', data.node.id.slice(0, 8), 'status=', data.node.status);
            return updateNode(prev, data.node);

          case 'generation_created':
            console.log('[useEvalState_v2] Generation created:', data.generation, 'with', data.nodes.length, 'nodes');
            return addGeneration(prev, data.generation, data.nodes);

          case 'totals':
            return {
              ...prev,
              totals: data.totals,
              cacheHits: data.cacheHits,
            };

          case 'population_ready':
            console.log('[useEvalState_v2] Population ready!');
            return prev; // No state change, just a notification

          case 'error':
            console.error('[useEvalState_v2] Error from backend:', data.message);
            return prev;

          default:
            console.warn('[useEvalState_v2] Unknown update type:', data.type);
            return prev;
        }
      });
    };

    const unsubscribe = window.electronAPI.eval.subscribe(evaluationId, handleUpdate);
    console.log('[useEvalState_v2] IPC subscription established');

    return () => {
      console.log('[useEvalState_v2] Cleaning up for evalId:', evaluationId?.slice(0, 8));
      isMounted = false;
      unsubscribe();
    };
  }, [evaluationId]);

  return { evaluation, isLoading };
}

/**
 * Helper: Create empty evaluation shell
 */
function createEmptyEvaluation(evaluationId: UUID): EvaluationRun {
  return {
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
  };
}

/**
 * Helper: Add a NEW node to evaluation
 */
function addNode(eval_: EvaluationRun, node: CandidateNode): EvaluationRun {
  const generations = [...eval_.generations];
  
  // Ensure generation exists
  while (generations.length <= node.generation) {
    generations.push([]);
  }
  
  // Check if node already exists (shouldn't happen with node_created, but be safe)
  const existingIndex = generations[node.generation].findIndex(n => n.id === node.id);
  if (existingIndex !== -1) {
    console.warn('[useEvalState_v2] node_created for existing node, treating as update');
    const newGen = [...generations[node.generation]];
    newGen[existingIndex] = node;
    generations[node.generation] = newGen;
  } else {
    // Add new node
    generations[node.generation] = [...generations[node.generation], node];
  }
  
  return { ...eval_, generations };
}

/**
 * Helper: Update an EXISTING node in evaluation
 */
function updateNode(eval_: EvaluationRun, node: CandidateNode): EvaluationRun {
  const generations = [...eval_.generations];
  
  // Ensure generation exists
  while (generations.length <= node.generation) {
    generations.push([]);
  }
  
  // Find and update node
  const existingIndex = generations[node.generation].findIndex(n => n.id === node.id);
  if (existingIndex !== -1) {
    const newGen = [...generations[node.generation]];
    newGen[existingIndex] = node;
    generations[node.generation] = newGen;
  } else {
    console.warn('[useEvalState_v2] node_updated for non-existent node, adding it');
    generations[node.generation] = [...generations[node.generation], node];
  }
  
  return { ...eval_, generations };
}

/**
 * Helper: Add an entire new generation
 */
function addGeneration(
  eval_: EvaluationRun,
  generation: number,
  nodes: CandidateNode[]
): EvaluationRun {
  const generations = [...eval_.generations];
  
  // Ensure we have enough generations
  while (generations.length <= generation) {
    generations.push([]);
  }
  
  // Set generation nodes
  generations[generation] = nodes;
  
  return { ...eval_, generations };
}

