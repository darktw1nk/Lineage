/**
 * DEV TOOL: Create test evaluations for UI testing
 * Run with: npm run dev, then call from browser console: window.electronAPI.dev.createTestEvals(10)
 */

import { getDatabase } from '@voxor/lineage-core';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationRun, EvaluationConfig, CandidateNode } from '@voxor/lineage-core';

export function createTestEvaluations(count: number = 5): string[] {
  const db = getDatabase();
  const createdIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const configId = uuidv4();
    const runId = uuidv4();

    // Create dummy config
    const config: EvaluationConfig = {
      id: configId,
      name: `Test Evaluation ${i + 1}`,
      selection: { policy: 'topk', topK: 3, eliteShare: 0.05 },
      operators: {
        mutationShare: 0.4,
        crossoverShare: 0.3,
        metaPrompting: { enabled: true, share: 0.2 },
        modelVariation: { enabled: true, share: 0.2 },
        paramVariation: {
          enabled: false,
          share: 0.2,
          temperature: { enabled: false, min: 0.5, max: 1.5 },
        },
      },
      population: {
        initialSize: 5,
        generationSize: 5,
        seedPrompt: 'Test seed prompt',
        fill: 'auto',
      },
      enabledModels: [
        { provider: 'openai', model: 'gpt-5-mini' },
      ],
      testSet: [
        {
          id: uuidv4(),
          name: 'Test Case 1',
          prompt: 'Test prompt',
          mode: 'llm_grade',
        },
      ],
      fitness: {
        weights: { quality: 0.5, safety: 0, cost: 0.25, latency: 0.25, stability: 0 },
        guardrails: [],
        costNorm: { mode: 'relative', maxUSDPerCall: 0.1 },
        latencyNorm: { mode: 'relative', maxMs: 30000 },
      },
      targets: {
        timeLimitMs: 3600000,
        budgetUSD: 10,
        maxGenerations: 3,
      },
      serviceModel: { provider: 'openai', model: 'gpt-5-mini' },
      parallelLimit: 5,
      serviceModelMaxTokens: 20000,
      retries: 3,
    };

    // Create dummy nodes
    const gen0Nodes: CandidateNode[] = [];
    for (let j = 0; j < 5; j++) {
      const nodeId = uuidv4();
      gen0Nodes.push({
        id: nodeId,
        generation: 0,
        status: 'finished',
        lineageParents: [],
        prompt: `Test prompt ${j + 1}`,
        params: { model: { provider: 'openai', model: 'gpt-5-mini' }, temperature: 0.7 },
        changeLog: [{ label: 'MUTATION', text: 'Initial' }],
        tests: [{
          testId: config.testSet[0].id,
          score: Math.random() * 10,
          passed: true,
          outputText: 'Test output',
          latencyMs: 1000,
          promptTokens: 100,
          completionTokens: 50,
        }],
        metrics: {
          fitness: Math.random() * 10,
          quality: Math.random() * 10,
          safety: 0,
          costUSD: 0.5,
          latencyMs: 500,
          stability: 1,
        },
        timings: { startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000 },
      });
    }

    // Create run
    const run: EvaluationRun = {
      id: runId,
      configId: config.id,
      startedAt: Date.now() - 10000,
      finishedAt: Date.now() - 1000,
      totals: { tokensPrompt: 500, tokensCompletion: 250, usd: 0.005, calls: 5 },
      generations: [gen0Nodes],
      cacheHits: 0,
      version: '1.0',
      stopReason: 'target',
    };

    // Insert into database
    const transaction = db.transaction(() => {
      // Insert config
      db.prepare(`
        INSERT INTO evaluation_configs (id, name, config_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(configId, config.name, JSON.stringify(config), Date.now());

      // Insert run
      db.prepare(`
        INSERT INTO evaluation_runs (id, config_id, started_at, finished_at, stop_reason, run_json, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(runId, configId, run.startedAt, run.finishedAt, run.stopReason, JSON.stringify(run), run.version);
    });

    transaction();
    createdIds.push(runId);
    console.log(`[DevTool] Created test evaluation ${i + 1}/${count}: ${runId}`);
  }

  console.log(`[DevTool] Created ${count} test evaluations successfully`);
  return createdIds;
}

