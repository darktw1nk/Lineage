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
  /** Apply a DB snapshot without discarding live events that beat it. */
  hydrate: (evalId: UUID, snapshot: EvaluationRun) => void;
  setRunFields: (evalId: UUID, fields: Partial<EvaluationRun>) => void;
  updateNodeInEvaluation: (evalId: UUID, node: CandidateNode) => void;
  addNodeToEvaluation: (evalId: UUID, node: CandidateNode) => void;
  addGenerationToEvaluation: (evalId: UUID, generation: number, nodes: CandidateNode[]) => void;
  updateTotals: (evalId: UUID, totals: any, cacheHits: number) => void;
  setHoldout: (evalId: UUID, holdout: EvaluationRun['holdout']) => void;
  addPlayoff: (evalId: UUID, playoff: { generation: number; ranking: UUID[]; decisive?: boolean }) => void;
  updateStatus: (evalId: UUID, status: string, totalPausedMs?: number, pausedAt?: number) => void;
  setStopReason: (evalId: UUID, reason: string) => void;
  setLoading: (evalId: UUID, isLoading: boolean) => void;
  
  // Subscription management
  subscribe: (evalId: UUID) => void;
  unsubscribe: (evalId: UUID) => void;
  /** Release everything except `keepId` and any run still live. */
  releaseInactive: (keepId: UUID | null) => void;
  cleanup: () => void;
}

/**
 * Is this a plausible array index for a generation?
 *
 * `generation` arrives over IPC and is used directly as an index into a
 * padding loop, so a node claiming 200000 allocated 200001 arrays and a
 * FRACTIONAL one threw: `while (len <= 1.5)` stops at 2, then
 * `generations[1.5]` is undefined and `.findIndex` blows up inside the
 * zustand set inside the IPC listener. The guard existed in only one of the
 * three identical loops.
 *
 * Padding itself is legitimate — it is how a late-subscribing renderer
 * catches up on generations it never saw — so this is a sanity ceiling, not
 * a tight bound. The largest run measured in this project was 60.
 */
const MAX_GENERATION_INDEX = 10_000;
function plausibleGeneration(generation: number, id?: string): boolean {
  if (Number.isInteger(generation) && generation >= 0 && generation <= MAX_GENERATION_INDEX) return true;
  console.warn(`[Store] Ignoring ${id ? String(id).slice(0, 8) : 'event'}: generation ${generation} is not a plausible index.`);
  return false;
}

/**
 * Is this a usable node?
 *
 * eval:import checks that `generations` is an array of arrays but never looks
 * INSIDE them, so a hand-edited or older export with null/number entries
 * imports cleanly and then throws on first render. LeftSidebar is the one panel
 * App.tsx does not wrap in an ErrorBoundary, so the whole window blanked with
 * the reason only in the closed-by-default Logs panel.
 */
function usableNode(n: unknown): n is CandidateNode {
  return !!n && typeof n === 'object' && typeof (n as CandidateNode).id === 'string';
}

/**
 * Events that arrived before the store had an entry for their run. Replayed by
 * hydrate(), in order, so a subscribe-then-await race cannot lose them.
 */
const pendingUpdates = new Map<UUID, any[]>();
/** Set by subscribe() so hydrate can replay through the same handler. */
const updateHandlers = new Map<UUID, (event: any, data: any) => void>();

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
  
  /**
   * Merge a DB snapshot into whatever the store already holds.
   *
   * useEvaluation subscribes FIRST and then awaits eval:get, so events can
   * land while the read is in flight — and setEvaluation replaces the entry
   * wholesale, so a snapshot taken BEFORE those events silently rewound
   * them. Per generation, keep whichever side has more nodes, and prefer the
   * live node when both have the same id: the snapshot is by definition the
   * older view.
   */
  /** Merge a few run-level fields without disturbing generations. */
  setRunFields: (evalId, fields) => {
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      const newEvaluations = new Map(state.evaluations);
      newEvaluations.set(evalId, { ...evaluation, ...fields });
      return { evaluations: newEvaluations };
    });
  },

  hydrate: (evalId, snapshot) => {
    set((state) => {
      const live = state.evaluations.get(evalId);
      const newEvaluations = new Map(state.evaluations);
      if (!live) {
        newEvaluations.set(evalId, snapshot);
        return { evaluations: newEvaluations };
      }

      const snapGens = snapshot.generations ?? [];
      const liveGens = live.generations ?? [];
      const merged: CandidateNode[][] = [];
      for (let g = 0; g < Math.max(snapGens.length, liveGens.length); g++) {
        const fromSnap = snapGens[g] ?? [];
        const fromLive = liveGens[g] ?? [];
        const byId = new Map<string, CandidateNode>();
        for (const n of fromSnap) if (usableNode(n)) byId.set(n.id, n);
        for (const n of fromLive) if (usableNode(n)) byId.set(n.id, n); // live wins
        merged.push([...byId.values()]);
      }

      newEvaluations.set(evalId, { ...snapshot, ...live, generations: merged });
      return { evaluations: newEvaluations };
    });

    // Replay anything that arrived before the entry existed, in order. Without
    // this the buffer would simply be a slower way of dropping them.
    const queued = pendingUpdates.get(evalId);
    pendingUpdates.delete(evalId);
    const handler = updateHandlers.get(evalId);
    if (queued?.length && handler) {
      console.log(`[Store] Replaying ${queued.length} update(s) buffered before hydrate`);
      for (const data of queued) handler(null, data);
    }
  },

  updateNodeInEvaluation: (evalId, node) => {
    if (!usableNode(node)) return;
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      
      const generations = [...evaluation.generations];

      if (!plausibleGeneration(node.generation, node.id)) return state;
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
    if (!usableNode(node)) return;
    set((state) => {
      const evaluation = state.evaluations.get(evalId);
      if (!evaluation) return state;
      
      if (!plausibleGeneration(node.generation, node.id)) return state;
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
      
      if (!plausibleGeneration(generation)) return state;
      const generations = [...evaluation.generations];
      
      // Ensure we have enough generations
      while (generations.length <= generation) {
        generations.push([]);
      }
      
      // Filter the payload: it is assigned verbatim, so one junk element
      // reaches LeftSidebar.getBestScore and throws.
      generations[generation] = (nodes ?? []).filter(usableNode);
      
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

      // BUFFER until the store has an entry for this run.
      //
      // Every mutator begins `const evaluation = ...get(evalId); if (!evaluation)
      // return state;`, and useEvaluation subscribes BEFORE awaiting eval:get —
      // so anything arriving in that window was silently dropped. Deterministic
      // on the Resume path (onSelectEvaluation is a plain setState with no wait
      // like the create flow has): measured 5 of 50 events discarded, including
      // the run's `status`. `status`, `stop`, `holdout_result` and
      // `playoff_result` each fire EXACTLY ONCE, at the end, so losing one means
      // it never appears until the app is restarted.
      if (!get().evaluations.has(evalId)) {
        const pending = pendingUpdates.get(evalId) ?? [];
        // Bounded: a run that is never hydrated must not grow this forever.
        if (pending.length < 500) pending.push(data);
        pendingUpdates.set(evalId, pending);
        return;
      }
      
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
          store.addPlayoff(evalId, { generation: data.generation, ranking: data.ranking, decisive: data.decisive });
          break;

        case 'cost_breakdown':
          // These were dropped, so the desktop had ZERO readers for either.
          // Fabricated placeholder scores were shown as measurements with no
          // disclosure at all, while the CLI report warns loudly on the very
          // same data. The Footer now surfaces ungradedTests.
          store.setRunFields(evalId, {
            costBreakdown: data.breakdown ?? undefined,
            estimate: data.estimate ?? undefined,
            ungradedTests: data.ungradedTests ?? undefined,
          });
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
    
    updateHandlers.set(evalId, handleUpdate);
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
  
  /**
   * Drop runs the user is no longer looking at.
   *
   * useEvaluation deliberately never unsubscribes on unmount, and
   * `unsubscribe` was called from exactly one place in the app (delete). So
   * clicking through the sidebar accumulated one IPC listener AND one full
   * run — every generation, every node output — per run visited: 13 runs
   * measured 13 listeners and 13 resident runs. Since eval:get returns the
   * whole run, that put back in the renderer exactly the memory the
   * eval:list summary split had just removed from the poll.
   *
   * A LIVE run is never released: its events are the reason to hold it.
   */
  releaseInactive: (keepId) => {
    const state = get();
    const LIVE = new Set(['running', 'pausing', 'paused']);
    for (const [id, evaluation] of state.evaluations) {
      if (id === keepId) continue;
      // An UNKNOWN status is not a dead run. run.status is written only at
      // specific lifecycle points, so a run started earlier and opened
      // mid-flight carries undefined — and this evicted it, killing its
      // subscription, the moment another run was opened.
      if (!evaluation.status || LIVE.has(String(evaluation.status))) continue;
      get().unsubscribe(id as UUID);
    }
  },

  cleanup: () => {
    const state = get();
    state.subscriptions.forEach((unsubscribe) => unsubscribe());
    set({ subscriptions: new Map(), evaluations: new Map(), loading: new Set() });
  },
}));
