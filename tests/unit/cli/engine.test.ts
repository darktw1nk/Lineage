import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EvaluationConfig, CandidateNode, UUID } from '@promptengine/core';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStartEvaluation = vi.fn();
const mockStopEvaluation = vi.fn();
let capturedSendUpdate: ((runId: UUID, data: any) => void) | null = null;

const mockDbPrepare = vi.fn();
const mockDbRun = vi.fn();

vi.mock('@promptengine/core', () => ({
  setSendUpdate: (fn: (runId: UUID, data: any) => void) => {
    capturedSendUpdate = fn;
  },
  startEvaluation: (...args: any[]) => mockStartEvaluation(...args),
  stopEvaluation: (...args: any[]) => mockStopEvaluation(...args),
  getDatabase: () => ({
    prepare: (sql: string) => {
      mockDbPrepare(sql);
      return { run: (...args: any[]) => mockDbRun(sql, ...args) };
    },
  }),
  closeDatabase: vi.fn(),
  setStore: vi.fn(),
}));

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    id: 'config-123',
    name: 'Test Evolution',
    selection: { policy: 'topk', topK: 3 },
    operators: { mutationShare: 0.5, crossoverShare: 0.3 },
    population: { initialSize: 4, generationSize: 4, seedPrompt: 'Be helpful.', fill: 'auto' },
    enabledModels: [{ provider: 'openai', model: 'gpt-4o' }],
    testSet: [{ id: 'test-1', name: 'Q1', mode: 'llm_grade', prompt: 'What is 1+1?' }],
    fitness: { weights: { quality: 1.0 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'openai', model: 'gpt-4o-mini' },
    parallelLimit: 2,
    serviceModelMaxTokens: 4096,
    retries: 3,
    ...overrides,
  };
}

function makeNode(overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    id: 'node-abc',
    generation: 0,
    lineageParents: [],
    status: 'finished',
    prompt: 'Be helpful.',
    params: { model: { provider: 'openai', model: 'gpt-4o' }, temperature: 0.7 },
    changeLog: [{ label: 'MUTATION', text: 'Initial mutation' }],
    tests: [
      {
        testId: 'test-1',
        passed: true,
        score: 8.0,
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 200,
        outputText: 'The answer is 2.',
        llmGradeReasoning: 'Correct answer.',
      },
    ],
    metrics: { quality: 8.0, fitness: 0.8 },
    ...overrides,
  };
}

/**
 * Simulate a full evolution lifecycle through the captured sendUpdate callback.
 */
function simulateEvolution(runId: string, nodes: CandidateNode[]): void {
  if (!capturedSendUpdate) throw new Error('sendUpdate not captured');
  const send = capturedSendUpdate;

  // Population ready
  for (const n of nodes) {
    send(runId, { type: 'node_created', node: n });
  }
  send(runId, { type: 'population_ready' });

  // Update each node to finished
  for (const n of nodes) {
    send(runId, { type: 'node_updated', node: { ...n, status: 'finished' } });
  }

  // Send totals
  send(runId, {
    type: 'totals',
    totals: { tokensPrompt: 500, tokensCompletion: 200, usd: 0.05, calls: 4 },
    cacheHits: 1,
  });

  // Finished
  send(runId, { type: 'status', status: 'finished' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI Engine - runEvolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSendUpdate = null;

    // Suppress stderr/stdout output during tests (re-created each test)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Default: startEvaluation triggers simulation after a tick
    mockStartEvaluation.mockImplementation(async (runId: string) => {
      // Schedule simulation for next tick so finishedPromise is set up
      setTimeout(() => {
        simulateEvolution(runId, [
          makeNode({ id: 'n1' }),
          makeNode({ id: 'n2', metrics: { quality: 9.0, fitness: 0.95 }, prompt: 'Better prompt' }),
        ]);
      }, 0);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('inserts config and run into DB before starting evaluation', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    const config = makeConfig();

    await runEvolution(config);

    // Check config INSERT
    const configInsertCall = mockDbRun.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('evaluation_configs'),
    );
    expect(configInsertCall).toBeDefined();
    expect(configInsertCall![1]).toBe('config-123'); // config.id
    expect(configInsertCall![2]).toBe('Test Evolution'); // config.name

    // Check run INSERT
    const runInsertCall = mockDbRun.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('evaluation_runs'),
    );
    expect(runInsertCall).toBeDefined();
    // runInsertCall: [sql, runId, configId, startedAt, runJson, version]
    expect(runInsertCall![2]).toBe('config-123'); // configId
    expect(runInsertCall![5]).toBe('1.0'); // version
  });

  it('inserts into DB before calling startEvaluation', async () => {
    const callOrder: string[] = [];

    mockDbRun.mockImplementation((sql: string) => {
      if (sql.includes('evaluation_configs')) callOrder.push('db:config');
      if (sql.includes('evaluation_runs')) callOrder.push('db:run');
    });
    mockStartEvaluation.mockImplementation(async (runId: string) => {
      callOrder.push('startEvaluation');
      setTimeout(() => simulateEvolution(runId, [makeNode()]), 0);
    });

    const { runEvolution } = await import('../../../cli/engine.js');
    await runEvolution(makeConfig());

    expect(callOrder).toEqual(['db:config', 'db:run', 'startEvaluation']);
  });

  it('returns rich result with generations, nodes, tests, and metrics', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    expect(result.runId).toBeDefined();
    expect(result.configId).toBe('config-123');
    expect(result.configName).toBe('Test Evolution');
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Totals
    expect(result.totals.usd).toBe(0.05);
    expect(result.totals.calls).toBe(4);
    expect(result.cacheHits).toBe(1);

    // Generations
    expect(result.generations.length).toBeGreaterThanOrEqual(1);
    const gen0 = result.generations[0];
    expect(gen0.generation).toBe(0);
    expect(gen0.nodes.length).toBe(2);

    // Node data richness
    const node = gen0.nodes.find((n) => n.id === 'n1');
    expect(node).toBeDefined();
    expect(node!.prompt).toBe('Be helpful.');
    expect(node!.params.model.provider).toBe('openai');
    expect(node!.changeLog).toHaveLength(1);
    expect(node!.changeLog[0].label).toBe('MUTATION');
    expect(node!.metrics).toBeDefined();
    expect(node!.metrics!.fitness).toBe(0.8);
    expect(node!.tests).toBeDefined();
    expect(node!.tests!).toHaveLength(1);
    expect(node!.tests![0].score).toBe(8.0);
    expect(node!.tests![0].outputText).toBe('The answer is 2.');
  });

  it('tracks best node correctly', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    expect(result.best).toBeDefined();
    expect(result.best!.nodeId).toBe('n2');
    expect(result.best!.fitness).toBe(0.95);
    expect(result.best!.quality).toBe(9.0);
    expect(result.best!.prompt).toBe('Better prompt');
    expect(result.best!.model).toBe('openai/gpt-4o');
  });

  it('records error event but continues to finished', async () => {
    // The evaluator only sends 'error' for non-fatal background mutation failures.
    // The evaluation loop continues and sends 'finished' afterward.
    mockStartEvaluation.mockImplementation(async (runId: string) => {
      setTimeout(() => {
        if (!capturedSendUpdate) return;
        capturedSendUpdate(runId, { type: 'error', message: 'Background mutation failed' });
        capturedSendUpdate(runId, { type: 'node_created', node: makeNode() });
        capturedSendUpdate(runId, {
          type: 'totals',
          totals: { tokensPrompt: 100, tokensCompletion: 50, usd: 0.01, calls: 1 },
          cacheHits: 0,
        });
        capturedSendUpdate(runId, { type: 'status', status: 'finished' });
      }, 0);
    });

    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    expect(result.error).toBe('Background mutation failed');
    // Still completes with data
    expect(result.totals.calls).toBe(1);
    expect(result.generations.length).toBeGreaterThanOrEqual(1);
  });

  it('handles startEvaluation throwing synchronously', async () => {
    mockStartEvaluation.mockRejectedValue(new Error('Setup failed: no models'));

    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    expect(result.error).toBe('Setup failed: no models');
    expect(result.best).toBeNull();
  });

  it('uses version 1.0 matching IPC handler', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    await runEvolution(makeConfig());

    const runInsertCall = mockDbRun.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('evaluation_runs'),
    );
    expect(runInsertCall).toBeDefined();
    // Last arg is version
    expect(runInsertCall![5]).toBe('1.0');
  });

  it('calls onRunId callback with the run ID', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    let capturedRunId: string | null = null;

    await runEvolution(makeConfig(), {
      onRunId: (id) => { capturedRunId = id; },
    });

    expect(capturedRunId).toBeDefined();
    expect(typeof capturedRunId).toBe('string');
    expect(capturedRunId!.length).toBeGreaterThan(0);
  });

  it('writes JSON to stdout', async () => {
    const { runEvolution } = await import('../../../cli/engine.js');
    await runEvolution(makeConfig());

    const stdoutCalls = stdoutSpy.mock.calls;
    expect(stdoutCalls.length).toBeGreaterThan(0);

    // Parse the last stdout write as JSON
    const jsonStr = stdoutCalls[stdoutCalls.length - 1][0] as string;
    const parsed = JSON.parse(jsonStr);
    expect(parsed.runId).toBeDefined();
    expect(parsed.configId).toBe('config-123');
    expect(parsed.generations).toBeDefined();
  });

  it('captures stop reason from stop event', async () => {
    mockStartEvaluation.mockImplementation(async (runId: string) => {
      setTimeout(() => {
        if (!capturedSendUpdate) return;
        const send = capturedSendUpdate;
        send(runId, { type: 'node_created', node: makeNode() });
        send(runId, { type: 'stop', reason: 'budget' });
        send(runId, { type: 'status', status: 'finished' });
      }, 0);
    });

    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    expect(result.stopReason).toBe('budget');
  });

  it('retries config INSERT on SQLITE_CONSTRAINT', async () => {
    let insertAttempts = 0;
    mockDbRun.mockImplementation((sql: string, ...args: any[]) => {
      if (sql.includes('evaluation_configs')) {
        insertAttempts++;
        if (insertAttempts <= 2) {
          const err: any = new Error('UNIQUE constraint failed');
          err.code = 'SQLITE_CONSTRAINT';
          throw err;
        }
      }
    });

    const { runEvolution } = await import('../../../cli/engine.js');
    const result = await runEvolution(makeConfig());

    // Should have retried 3 times (2 failures + 1 success)
    expect(insertAttempts).toBe(3);
    // configId in result should differ from original since it was regenerated
    // (The first config-123 failed, so it got a new UUID)
    expect(result.configId).not.toBe('config-123');
  });
});
