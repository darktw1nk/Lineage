import { create } from 'zustand';
import type { UUID, EvaluationRun, CandidateNode } from '../types';

interface EvaluationState {
  selectedEvaluationId: UUID | null;
  selectedNodeId: UUID | null;
  evaluations: Map<UUID, EvaluationRun>;
  
  // Actions
  setSelectedEvaluation: (id: UUID | null) => void;
  setSelectedNode: (id: UUID | null) => void;
  updateEvaluation: (id: UUID, run: EvaluationRun) => void;
  updateNode: (evalId: UUID, node: CandidateNode) => void;
}

export const useEvaluationStore = create<EvaluationState>((set) => ({
  selectedEvaluationId: null,
  selectedNodeId: null,
  evaluations: new Map(),
  
  setSelectedEvaluation: (id) => set({ selectedEvaluationId: id }),
  setSelectedNode: (id) => set({ selectedNodeId: id }),
  
  updateEvaluation: (id, run) => set((state) => {
    const newEvaluations = new Map(state.evaluations);
    newEvaluations.set(id, run);
    return { evaluations: newEvaluations };
  }),
  
  updateNode: (evalId, node) => set((state) => {
    const evaluation = state.evaluations.get(evalId);
    if (!evaluation) return state;
    
    // Update node in the appropriate generation
    const updatedGenerations = evaluation.generations.map(gen =>
      gen.map(n => n.id === node.id ? node : n)
    );
    
    const updatedRun = {
      ...evaluation,
      generations: updatedGenerations,
    };
    
    const newEvaluations = new Map(state.evaluations);
    newEvaluations.set(evalId, updatedRun);
    
    return { evaluations: newEvaluations };
  }),
}));

