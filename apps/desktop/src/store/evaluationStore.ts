/**
 * Centralized Evaluation State Store
 * 
 * Single source of truth for evaluation state
 * All components read from this store
 * Only one IPC subscription per evaluation
 */

import { create } from 'zustand';
import type { UUID, EvaluationRun, CandidateNode } from '../types';

interface EvaluationStore {
  // Current evaluation data
  evaluations: Map<UUID, EvaluationRun>;
  
  // IPC subscription cleanup functions
  subscriptions: Map<UUID, () => void>;
  
  // Loading states
  loading: Set<UUID>;
  
  // Actions
  setEvaluation: (evalId: UUID, evaluation: EvaluationRun) => void;
  updateNodeInEvaluation: (evalId: UUID, node: CandidateNode) => void;
  addNodeToEvaluation: (evalId: UUID, node: CandidateNode) => void;
  addGenerationToEvaluation: (evalId: UUID, generation: number, nodes: CandidateNode[]) => void;
  updateTotals: (evalId: UUID, totals: any, cacheHits: number) => void;
  setHoldout: (evalId: UUID, holdout: EvaluationRun['holdout']) => void;
  addPlayoff: (evalId: UUID, playoff: { generation: number; ranking: UUID[] }) => void;
  updateStatus: (evalId: UUID, status: string, totalPausedMs?: number, pausedAt?: number) => void;
  setLoading: (evalId: UUID, isLoading: boolean) => void;
  
  // Subscription management
  subscribe: (evalId: UUID) => void;
  unsubscribe: (evalId: UUID) => void;
  cleanup: () => void;
}

export const useEvaluationStore = create<EvaluationStore>((set, get) => ({
  evaluations: new Map(),
  subscriptions: new Map(),
  loading: new Set(),
  
  setEvaluation: (evalId, evaluation) => {
    set((state) => {
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, evaluation);
      return { evaluations: newEvaluations };
    });
  },
  
  updateNodeInEvaluation: (evalId, node) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      
      const generations = [...evaluation.generations];
      
      // Ensure generation exists
      while (generations.length <= node.generation) {
        generations.push([]);
      }
      
      // Find and update node
      const gen = generations[node.generation];
      const index = gen.findIndex(n => n.id === node.id);
      
      if (index !== -1) {
        generations[node.generation] = [
          ...gen.slice(0, index),
          node,
          ...gen.slice(index + 1)
        ];
      } else {
        // Node doesn't exist - add it
        console.warn(`[Store] node_updated for non-existent node ${node.id.slice(0, 8)}, adding to gen ${node.generation}`);
        generations[node.generation] = [...gen, node];
      }
      
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, generations });
      
      return { evaluations: newEvaluations };
    });
  },
  
  addNodeToEvaluation: (evalId, node) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      
      const generations = [...evaluation.generations];
      
      // Ensure generation exists
      while (generations.length <= node.generation) {
        generations.push([]);
      }
      
      // Add node
      generations[node.generation] = [...generations[node.generation], node];
      
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, generations });
      
      return { evaluations: newEvaluations };
    });
  },
  
  addGenerationToEvaluation: (evalId, generation, nodes) => {
    console.log(`[Store] Adding generation ${generation} with ${nodes.length} nodes to eval ${evalId.slice(0, 8)}`);
    
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) {
        console.warn(`[Store] Evaluation ${evalId.slice(0, 8)} not found when adding generation`);
        return state;
      }
      
      const generations = [...evaluation.generations];
      
      // Ensure we have enough generations
      while (generations.length <= generation) {
        generations.push([]);
      }
      
      // Set generation nodes
      generations[generation] = nodes;
      
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, generations });
      
      console.log(`[Store] Eval ${evalId.slice(0, 8)} now has ${generations.length} generations`);
      
      return { evaluations: newEvaluations };
    });
  },
  
  updateTotals: (evalId, totals, cacheHits) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;

      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, totals, cacheHits });

      return { evaluations: newEvaluations };
    });
  },

  addPlayoff: (evalId, playoff) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;

      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, playoffs: [...(evaluation.playoffs ?? []), playoff] });

      return { evaluations: newEvaluations };
    });
  },

  setHoldout: (evalId, holdout) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;

      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, holdout });

      return { evaluations: newEvaluations };
    });
  },
  
  updateStatus: (evalId, status, totalPausedMs, pausedAt) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      
      const newEvaluations = new Map(state.evaluations);
      const updated = { ...evaluation, status: status as any };
      if (totalPausedMs !== undefined) {
        updated.totalPausedMs = totalPausedMs;
      }
      if (pausedAt !== undefined) {
        updated.pausedAt = pausedAt;
      }
      newEvaluations.set(evalId, updated);
      
      return { evaluations: newEvaluations };
    });
  },
  
  setLoading: (evalId, isLoading) => {
    set((state) => {
      const newLoading = new Set(state.loading);
      if (isLoading) {
        newLoading.add(evalId);
      } else {
        newLoading.delete(evalId);
      }
      return { loading: newLoading };
    });
  },
  
  subscribe: (evalId) => {
    const state = get();
    
    // Don't subscribe twice
    if (state.subscriptions.has(evalId)) {
      console.log(`[Store] Already subscribed to ${evalId.slice(0, 8)}`);
      return;
    }
    
    console.log(`[Store] Subscribing to IPC updates for ${evalId.slice(0, 8)}`);
    
    const handleUpdate = (_event: any, data: any) => {
      if (!data || !data.type) return;
      
      console.log(`[Store] IPC update for ${evalId.slice(0, 8)}:`, data.type, data);
      
      const store = get();
      
      switch (data.type) {
        case 'status':
          store.updateStatus(evalId, data.status, data.totalPausedMs, data.pausedAt);
          break;
          
        case 'node_created':
          console.log(`[Store] Handling node_created: gen=${data.node.generation}, id=${data.node.id.slice(0, 8)}`);
          store.addNodeToEvaluation(evalId, data.node);
          break;
          
        case 'node_updated':
          store.updateNodeInEvaluation(evalId, data.node);
          break;
          
        case 'generation_created':
          console.log(`[Store] Handling generation_created: gen=${data.generation}, nodes=${data.nodes.length}`);
          store.addGenerationToEvaluation(evalId, data.generation, data.nodes);
          break;
          
        case 'totals':
          store.updateTotals(evalId, data.totals, data.cacheHits);
          break;

        case 'holdout_result':
          store.setHoldout(evalId, data.holdout);
          break;

        case 'playoff_result':
          store.addPlayoff(evalId, { generation: data.generation, ranking: data.ranking });
          break;
          
        default:
          console.warn(`[Store] Unknown IPC event type: ${data.type}`);
      }
    };
    
    const unsubscribe = window.electronAPI.eval.subscribe(evalId, handleUpdate);
    
    set((state) => {
      const newSubscriptions = new Map(state.subscriptions);
      newSubscriptions.set(evalId, unsubscribe);
      return { subscriptions: newSubscriptions };
    });
  },
  
  unsubscribe: (evalId) => {
    const state = get();
    const unsubscribe = state.subscriptions.get(evalId);
    
    if (unsubscribe) {
      console.log(`[Store] Unsubscribing from ${evalId.slice(0, 8)}`);
      unsubscribe();
      
      set((state) => {
        const newSubscriptions = new Map(state.subscriptions);
        newSubscriptions.delete(evalId);
        return { subscriptions: newSubscriptions };
      });
    }
  },
  
  cleanup: () => {
    const state = get();
    state.subscriptions.forEach((unsubscribe) => unsubscribe());
    set({ subscriptions: new Map(), evaluations: new Map(), loading: new Set() });
  },
}));
