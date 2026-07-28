import { describe, it, expect } from 'vitest';
import {
  getState,
  resetState,
  onNodeCreated,
  onNodeUpdated,
  onTotals,
} from '../../../cli/display.js';
import type { CandidateNode } from '../../../src/types/index.js';

function makeNode(overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    id: 'node-1',
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt: 'test prompt',
    params: { model: { provider: 'openai', model: 'gpt-4o' }, temperature: 0.7 },
    changeLog: [],
    metrics: { fitness: 0.85, quality: 8.5 },
    ...overrides,
  };
}

describe('CLI Display', () => {
  describe('resetState', () => {
    it('resets all fields to initial values', () => {
      // Mutate state via display functions
      onNodeCreated(makeNode());
      onNodeCreated(makeNode({ id: 'node-2' }));
      onNodeUpdated(makeNode({ metrics: { fitness: 0.95, quality: 9.5 } }));
      onTotals({ usd: 1.23, calls: 10 }, 3);

      const before = getState();
      expect(before.nodesTotal).toBeGreaterThan(0);
      expect(before.bestFitness).toBeGreaterThan(0);
      expect(before.totalCost).toBeGreaterThan(0);

      resetState();

      const after = getState();
      expect(after.currentGeneration).toBe(0);
      expect(after.nodesFinished).toBe(0);
      expect(after.nodesTotal).toBe(0);
      expect(after.bestFitness).toBe(0);
      expect(after.bestPrompt).toBe('');
      expect(after.totalCost).toBe(0);
      expect(after.totalCalls).toBe(0);
      expect(after.cacheHits).toBe(0);
    });

    it('allows fresh tracking after reset', () => {
      onNodeUpdated(makeNode({ metrics: { fitness: 0.9 } }));
      resetState();

      // New events should track from scratch
      onNodeCreated(makeNode({ id: 'fresh-1' }));
      onNodeUpdated(makeNode({ id: 'fresh-1', metrics: { fitness: 0.5 } }));

      const state = getState();
      expect(state.nodesTotal).toBe(1);
      expect(state.nodesFinished).toBe(1);
      expect(state.bestFitness).toBe(0.5);

      // Clean up for other tests
      resetState();
    });
  });
});
