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
  setStopReason: (evalId: UUID, reason: string) => void;
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

      // Idempotent add: resume replays node_created for checkpointed nodes the
      // store may already hold (from selecting the run) — replace, never duplicate
      const existing = generations[node.generation].findIndex(n => n.id === node.id);
      if (existing !== -1) {
        const updated = [...generations[node.generation]];
        updated[existing] = node;
        generations[node.generation] = updated;
      } else {
        generations[node.generation] = [...generations[node.generation], node];
      }
      
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

      // Idempotent per generation: a resumed run can re-run a generation's
      // playoff — replace that generation's entry instead of duplicating it
      const playoffs = [...(evaluation.playoffs ?? []).filter(p => p.generation !== playoff.generation), playoff];
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, playoffs });

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
      // A terminal status always clears pausedAt, and 'running' means resumed —
      // the engine sends pausedAt: undefined to say "clear it", which a plain
      // !== undefined check silently ignored, leaving a stale timestamp.
      if (pausedAt !== undefined) {
        updated.pausedAt = pausedAt;
      } else if (status === 'running' || status === 'finished' || status === 'stopped') {
        updated.pausedAt = undefined;
      }
      if (status === 'finished' && updated.finishedAt === undefined) {
        updated.finishedAt = Date.now();
      }
      newEvaluations.set(evalId, updated);

      return { evaluations: newEvaluations };
    });
  },

  setStopReason: (evalId, reason) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, stopReason: reason as any });
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
      
      // Type only, and nothing at all for the per-CALL events. Logging the full
      // payload here printed a whole node (250 KB with large outputs) for every
      // node_updated and a totals object for every API call — ~30,000 lines and
      // hundreds of MB of console traffic in a single 20-generation run.
      if (data.type !== 'totals' && data.type !== 'node_updated') {
        console.log(`[Store] IPC update for ${evalId.slice(0, 8)}: ${data.type}`);
      }
      
      const store = get();
      
      switch (data.type) {
        case 'status':
          store.updateStatus(evalId, data.status, data.totalPausedMs, data.pausedAt);
          break;

        case 'stop':
          // Why the run ended (budget/time/target/manual/...). Without this the
          // live UI showed a plain "Finished" and only revealed the real reason
          // after an app restart re-read run_json.
          store.setStopReason(evalId, data.reason);
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

        case 'cost_breakdown':
          // Persisted on run_json; no live UI yet
          break;
          
        // Emitted by the engine and previously logged as "unknown". Neither
        // carries state the store needs — population_ready is a progress
        // signal, and errors are surfaced as toasts in App.tsx — but treating
        // real events as unknown buries an actual unknown in the noise.
        case 'population_ready':
          break;

        case 'error':
          // App.tsx only toasts errors for the SELECTED evaluation, so a
          // failure on any other running run was invisible.
          console.error(`[Store] Run ${evalId.slice(0, 8)} reported an error:`, data.message);
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
    }
    // Drop the cached graph too. Keeping it meant a deleted run's full node
    // set stayed resident for the whole session, and a late event could still
    // resurrect it in the UI.
    set((state) => {
      const newSubscriptions = new Map(state.subscriptions);
      newSubscriptions.delete(evalId);
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.delete(evalId);
      const newLoading = new Set(state.loading);
      newLoading.delete(evalId);
      return { subscriptions: newSubscriptions, evaluations: newEvaluations, loading: newLoading };
    });
  },
  
  cleanup: () => {
    const state = get();
    state.subscriptions.forEach((unsubscribe) => unsubscribe());
    set({ subscriptions: new Map(), evaluations: new Map(), loading: new Set() });
  },
}));
