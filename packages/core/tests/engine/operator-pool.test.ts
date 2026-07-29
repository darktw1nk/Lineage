import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { resetRegistry, registerOperator } from '../../src/registry.js';
import { createNextGeneration } from '../../src/engine/generation.js';
import { initGlobalSemaphore, withGlobalSemaphore } from '../../src/engine/semaphore.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

const CALL_MS = 20;
const CALLS_PER_CHILD = 2;
const PARALLEL_LIMIT = 4;

let peakApplies = 0;   // operators whose apply() is in flight
let applies = 0;

/**
 * Calls go through the GLOBAL SEMAPHORE, exactly as every real operator's do
 * via BaseProviderAdapter. That queueing is the whole point: a child's liveness
 * clock starts at apply(), but its calls then wait behind every sibling's.
 */
function registerSlowOperator() {
  registerOperator({
    name: 'slowop',
    parents: 1,
    async apply({ parent }: any) {
      applies++;
      peakApplies = Math.max(peakApplies, applies);
      try {
        for (let c = 0; c < CALLS_PER_CHILD; c++) {
          await withGlobalSemaphore(() => new Promise(r => setTimeout(r, CALL_MS)));
        }
      } finally {
        applies--;
      }
      return {
        prompt: parent.prompt + '+',
        changeLog: [{ label: 'MUTATION', text: 'slow' }],
        params: {},
        cost: { promptTokens: 1, completionTokens: 1, usd: 0, calls: CALLS_PER_CHILD },
      };
    },
  } as any);
}

function parentNode(id: string, fitness: number): CandidateNode {
  return {
    id, generation: 0, lineageParents: [], status: 'finished', prompt: 'P-' + id,
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [], metrics: { fitness, quality: fitness },
    tests: [{ testId: 't1', passed: true, score: fitness, promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o' }],
  } as any;
}

const config = (popSize: number) => ({
  id: 'c', name: 'c',
  selection: { policy: 'topk', topK: 3, eliteShare: 0 },
  operators: { mutationShare: 0, crossoverShare: 0, custom: { slowop: { share: 1 } } },
  population: { initialSize: popSize, generationSize: popSize, seedPrompt: 'SEED', fill: 'auto' },
  enabledModels: [{ provider: 'x', model: 'y' }],
  serviceModel: { provider: 'x', model: 'y' },
  testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
  fitness: { weights: { quality: 1 } },
  targets: { maxGenerations: 3 },
  parallelLimit: PARALLEL_LIMIT,
  // Liveness budget is 6x this. Deliberately tight so the test finishes fast;
  // the ratio to total queued work is what a real large-population run hits.
  callTimeoutMs: CALL_MS * 3,
  serviceModelMaxTokens: 100, retries: 1,
} as unknown as EvaluationConfig);

const parents = () => [parentNode('p1', 9), parentNode('p2', 8), parentNode('p3', 7)];

beforeEach(() => { resetRegistry(); peakApplies = 0; applies = 0; initGlobalSemaphore(PARALLEL_LIMIT); });

describe('the operator batch is bounded by parallelLimit', () => {
  it('does not call apply() for every child in the same tick', async () => {
    // withOperatorTimeout starts its clock inside apply(). Starting all P of
    // them at once means the clock runs while the work sits in the semaphore
    // queue, so the budget measures QUEUE DEPTH rather than liveness.
    registerSlowOperator();
    const p = parents();
    await createNextGeneration(p, p, 1, config(24), [p]);
    expect(peakApplies).toBeLessThanOrEqual(PARALLEL_LIMIT);
    expect(peakApplies).toBeGreaterThan(1); // still concurrent, just bounded
  }, 60000);

  it('a large population does not lose children to the liveness timeout', async () => {
    // Measured before the fix, at parallelLimit 2 with 500ms calls:
    // popSize 10 lost 1 child to "did not finish within", popSize 20 lost 2,
    // popSize 40 lost 13 (33%). Past the cliff every child is a carry-forward
    // clone of its parent — evolution silently stops and the run still reports
    // success.
    registerSlowOperator();
    const p = parents();
    const result = await createNextGeneration(p, p, 1, config(60), [p]);

    const lost = result.newNodes.filter(n =>
      n.changeLog?.some(c => /did not finish within|failed, using parent/.test(c.text)));
    expect(lost.map(n => n.id)).toHaveLength(0);
    expect(result.newNodes).toHaveLength(60);
  }, 120000);
});
