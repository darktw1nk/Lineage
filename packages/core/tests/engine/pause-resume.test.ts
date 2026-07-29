import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { registerProvider, resetRegistry } from '../../src/registry.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/database/init.js';
import {
  setSendUpdate, startEvaluation, pauseEvaluation, resumeEvaluation, isEvaluationActive,
} from '../../src/engine/evaluator_v2.js';

/**
 * A gate the test opens and closes, so pause/resume can be aimed at an exact
 * point in the run instead of at a wall-clock guess. Timing-based tests did NOT
 * reproduce either race — they passed against the broken code.
 */
class Gate {
  private waiters: Array<() => void> = [];
  private open = true;
  private arrived: Array<() => void> = [];

  close() { this.open = false; }
  release() {
    this.open = true;
    this.waiters.splice(0).forEach(w => w());
  }
  /** Resolves once at least one caller is blocked on the gate. */
  waitForArrival(): Promise<void> {
    return new Promise(res => {
      if (!this.open && this.waiters.length > 0) return res();
      this.arrived.push(res);
    });
  }
  async pass(): Promise<void> {
    if (this.open) return;
    const p = new Promise<void>(res => this.waiters.push(res));
    this.arrived.splice(0).forEach(a => a());
    return p;
  }
}

function registerGatedAdapter(gate: Gate, gateEvaluationCalls: boolean) {
  registerProvider({
    adapter: {
      name: 'gated',
      estimateTokens: () => ({ prompt: 1 }),
      call: async (opts: any) => {
        const base = { promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
        const p: string = opts.prompt;
        const isOperatorCall = p.includes('mutations to improve') || p.includes('Produce the NEW prompt ONLY');
        if (gateEvaluationCalls && !isOperatorCall) await gate.pass();
        if (p.includes('mutations to improve')) return { ...base, output: '[{"label":"MUTATION","edit":"x"}]' };
        if (p.includes('Produce the NEW prompt ONLY')) return { ...base, output: 'V' + Math.random().toString(36).slice(2, 8) };
        return { ...base, output: opts.system ?? p };
      },
    } as any,
  });
}

function makeConfig(over: any = {}) {
  return {
    id: 'pr-cfg', name: 'pause-resume',
    selection: { policy: 'topk', topK: 2, eliteShare: 0.05 },
    operators: { mutationShare: 1, crossoverShare: 0 },
    population: { initialSize: 3, generationSize: 3, seedPrompt: 'SEED', fill: 'auto' },
    enabledModels: [{ provider: 'gated', model: 'm' }],
    testSet: [{ id: 't1', name: 'a', mode: 'exact_match', prompt: 'IN', expected: 'IN' }],
    fitness: { weights: { quality: 1 } },
    targets: { maxGenerations: 2 },
    serviceModel: { provider: 'gated', model: 'm' },
    parallelLimit: 8, serviceModelMaxTokens: 100, retries: 1,
    ...over,
  } as any;
}

function setupDb(config: any) {
  const tmpDb = path.join(os.tmpdir(), `pe-pr-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  return { tmpDb, config };
}

async function bootstrap(config: any) {
  const { tmpDb } = setupDb(config);
  await initializeDatabase(tmpDb);
  const db = getDatabase();
  db.prepare('INSERT INTO evaluation_configs (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(config.id, config.name, JSON.stringify(config), Date.now());
  const run: any = {
    id: 'pr-' + Math.random().toString(36).slice(2), configId: config.id, startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 }, generations: [], cacheHits: 0, version: '1.0',
  };
  db.prepare('INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version) VALUES (?, ?, ?, ?, ?)')
    .run(run.id, run.configId, run.startedAt, JSON.stringify(run), run.version);
  return { tmpDb, db, run };
}

function teardown(tmpDb: string) {
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}.lock`, { force: true });
  setSendUpdate(() => {});
}

beforeEach(() => resetRegistry());

describe('pause/resume never wedges the run', () => {
  it('a resume that lands DURING the pause drain still finishes', async () => {
    // The resume was rejected by the re-entrancy guard (loopRunning was still
    // true while draining), and the draining loop then returned without
    // restarting anything — so NO loop was left running. The run sat at status
    // 'running' forever, and a second resume was refused for not being 'paused'.
    const gate = new Gate();
    registerGatedAdapter(gate, true);
    const config = makeConfig();
    const { tmpDb, db, run } = await bootstrap(config);

    let finished = false;
    const done = new Promise<void>(res => setSendUpdate((_id, d) => {
      if (d.type === 'status' && d.status === 'finished') { finished = true; res(); }
    }));

    gate.close();
    await startEvaluation(run.id, config, run);
    await gate.waitForArrival();        // a candidate call is now in flight

    pauseEvaluation(run.id);            // loop breaks out and begins draining
    await new Promise(r => setTimeout(r, 250)); // let the drain actually start
    resumeEvaluation(run.id);           // <-- lands INSIDE the drain
    gate.release();                     // let the in-flight call complete

    await Promise.race([done, new Promise(r => setTimeout(r, 15000))]);

    const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
    const stillActive = isEvaluationActive(run.id);
    teardown(tmpDb);

    expect(finished).toBe(true);
    expect(final.status).toBe('finished');
    expect(stillActive).toBe(false);
  }, 40000);

  it('a pause/resume cycle completes the run and leaves no state registered', async () => {
    // Weaker than the case above: this covers the ordinary cycle, not the
    // generation-boundary variant (resume with queue AND inProgress both 0
    // while a generation transition is still pending). That variant is fixed in
    // resumeEvaluation, but this test does NOT reproduce it — see the note in
    // the commit; it was proven by an external harness only.
    const gate = new Gate();
    registerGatedAdapter(gate, true);
    const config = makeConfig();
    const { tmpDb, db, run } = await bootstrap(config);

    const statuses: string[] = [];
    let finished = false;
    const done = new Promise<void>(res => setSendUpdate((_id, d) => {
      if (d.type === 'status') {
        statuses.push(d.status);
        if (d.status === 'finished') { finished = true; res(); }
      }
    }));

    gate.close();
    await startEvaluation(run.id, config, run);
    await gate.waitForArrival();

    pauseEvaluation(run.id);
    gate.release();
    for (let i = 0; i < 100 && !statuses.includes('paused'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(statuses).toContain('paused');

    resumeEvaluation(run.id);
    await Promise.race([done, new Promise(r => setTimeout(r, 15000))]);

    const final = JSON.parse((db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?').get(run.id) as any).run_json);
    const stillActive = isEvaluationActive(run.id);
    teardown(tmpDb);

    expect(finished).toBe(true);
    expect(final.generations.length).toBe(2);
    expect(stillActive).toBe(false);
  }, 40000);
});
