import { IpcMain, app } from 'electron';
import { validateSettings } from './validateSettings.js';
import type { EvaluationConfig, EvaluationRun, ModelRef, ModelCostEntry, AppSettings } from '@promptengine/core';
import { getDatabase, store, OpenRouterAdapter, isEvaluationActive } from '@promptengine/core';
import { v4 as uuidv4 } from 'uuid';
import { getLogBuffer } from '../logger.js';

export function registerIPCHandlers(ipcMain: IpcMain): void {
  // Logger handler
  ipcMain.handle('logs:getBuffer', async () => {
    return getLogBuffer();
  });
  
  // Evaluation handlers
  ipcMain.handle('eval:create', async (_event, config: EvaluationConfig) => {
    return createEvaluation(config);
  });
  
  ipcMain.handle('eval:start', async (_event, runId: string) => {
    return startEvaluation(runId);
  });
  
  ipcMain.handle('eval:pause', async (_event, runId: string) => {
    return pauseEvaluation(runId);
  });
  
  ipcMain.handle('eval:resume', async (_event, runId: string) => {
    return resumeEvaluation(runId);
  });
  
  ipcMain.handle('eval:stop', async (_event, runId: string) => {
    return stopEvaluation(runId);
  });
  
  ipcMain.handle('eval:list', async () => {
    return listEvaluations();
  });

  ipcMain.handle('eval:get', async (_event, runId: string) => {
    return getEvaluation(runId);
  });
  
  ipcMain.handle('eval:export', async (_event, runId: string) => {
    return exportEvaluation(runId);
  });
  
  ipcMain.handle('eval:import', async (_event, filePath: string) => {
    return importEvaluation(filePath);
  });
  
  ipcMain.handle('eval:delete', async (_event, runId: string) => {
    return deleteEvaluation(runId);
  });
  
  ipcMain.handle('eval:getConfig', async (_event, runId: string) => {
    return getEvaluationConfig(runId);
  });

  ipcMain.handle('eval:estimate', async (_event, config: EvaluationConfig) => {
    try {
      const { estimateRunCost, getModelCost } = await import('@promptengine/core');
      return await estimateRunCost(config, getModelCost);
    } catch (error) {
      console.error('[IPC] eval:estimate failed:', error);
      return null;
    }
  });
  
  // Settings handlers
  ipcMain.handle('settings:get', async () => {
    return getSettings();
  });
  
  ipcMain.handle('settings:set', async (_event, settings: AppSettings) => {
    return setSettings(settings);
  });
  
  // API Keys handlers
  ipcMain.handle('keys:save', async (_event, provider: string, key: string) => {
    return saveApiKey(provider, key);
  });
  
  ipcMain.handle('keys:get', async (_event, provider: string) => {
    return getApiKey(provider);
  });
  
  ipcMain.handle('keys:test', async (_event, provider: string) => {
    return testApiKey(provider);
  });
  
  // 'keys:debug' removed: it returned every DECRYPTED secret in the store to
  // the renderer, had no caller anywhere in the app, and DevTools opens
  // automatically in dev. If you need to inspect keys while debugging, log them
  // in the main process instead of exposing a channel that hands them out.

  // Cost table handlers
  ipcMain.handle('costs:get', async (_event, modelRef: ModelRef) => {
    return getModelCost(modelRef);
  });
  
  ipcMain.handle('costs:set', async (_event, entry: ModelCostEntry) => {
    return setModelCost(entry);
  });

  ipcMain.handle('costs:setMany', async (_event, entries: ModelCostEntry[]) => {
    return setModelCosts(entries);
  });
  
  ipcMain.handle('costs:getAll', async () => {
    return getAllModelCosts();
  });

  // OpenRouter model discovery handlers
  ipcMain.handle('models:fetch-openrouter', async () => {
    return fetchOpenRouterModels();
  });

  ipcMain.handle('models:sync-openrouter', async () => {
    return syncOpenRouterModels();
  });

  // System Prompts handlers
  ipcMain.handle('systemPrompts:get', async () => {
    return getSystemPrompts();
  });

  ipcMain.handle('systemPrompts:set', async (_event, prompts: any) => {
    return setSystemPrompts(prompts);
  });

  // Dev Tools (only in development)
  // `app.isPackaged`, NOT NODE_ENV: nothing sets NODE_ENV, and
  // vite-plugin-electron's `define: { 'process.env': 'process.env' }` blocks
  // static replacement, so the built artifact still read it at runtime and
  // `undefined !== 'production'` shipped the handler.
  if (!app.isPackaged) {
    ipcMain.handle('dev:createTestEvals', async (_event, count: number) => {
      const { createTestEvaluations } = await import('../dev-tools/createTestEvaluations.js');
      return createTestEvaluations(count);
    });
  }
}

// Implementation functions

async function createEvaluation(config: EvaluationConfig): Promise<EvaluationRun> {
  const db = getDatabase();
  
  // Ensure unique ID (in case of conflicts, generate a new one)
  let configId = config.id;
  let attempts = 0;
  while (attempts < 10) {
    try {
      // Save config
      db.prepare(`
        INSERT INTO evaluation_configs (id, name, config_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        configId,
        config.name,
        JSON.stringify({ ...config, id: configId }),
        Date.now()
      );
      break; // Success, exit loop
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT' && attempts < 9) {
        // ID conflict, generate new one and retry
        console.log(`[CreateEval] Config ID ${configId} already exists, generating new one...`);
        configId = uuidv4();
        attempts++;
      } else {
        throw error; // Not a constraint error or too many retries
      }
    }
  }
  
  config.id = configId; // Update with final ID
  
  // Create run
  const run: EvaluationRun = {
    id: uuidv4(),
    configId: config.id,
    startedAt: Date.now(),
    totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
    generations: [],
    cacheHits: 0,
    version: '1.0',
  };

  // Stamp the preflight estimate — the report compares it to actual spend
  try {
    const { estimateRunCost, getModelCost } = await import('@promptengine/core');
    const est = await estimateRunCost(config, getModelCost);
    run.estimate = { calls: est.calls, low: est.low, high: est.high, breakdown: est.breakdown };
  } catch (error) {
    console.warn('[IPC] estimate stamping failed (non-fatal):', error);
  }
  
  const runInsert = db.prepare(`
    INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version)
    VALUES (?, ?, ?, ?, ?)
  `);

  try {
    runInsert.run(
      run.id,
      run.configId,
      run.startedAt,
      JSON.stringify(run),
      run.version
    );
  } catch (error) {
    // Roll back the config row by hand. These two inserts are separated by an
    // async estimate call so they cannot share a sql.js transaction, and
    // without this a failed run insert left a config row that listEvaluations
    // never returns and no handler can delete — one orphan per failed attempt.
    try {
      db.prepare('DELETE FROM evaluation_configs WHERE id = ?').run(config.id);
    } catch (cleanupError) {
      console.error('[CreateEval] Could not remove the orphaned config row:', cleanupError);
    }
    throw error;
  }

  return run;
}

async function startEvaluation(runId: string): Promise<void> {
  try {
    console.log('[IPC] startEvaluation called for runId:', runId);
    const db = getDatabase();
    const row = db.prepare(`
      SELECT run_json, config_id FROM evaluation_runs WHERE id = ?
    `).get(runId) as { run_json: string; config_id: string } | undefined;
    
    if (!row) {
      console.error('[IPC] Evaluation run not found:', runId);
      throw new Error('Evaluation run not found');
    }
    
    console.log('[IPC] Found run, config_id:', row.config_id);
    const run: EvaluationRun = JSON.parse(row.run_json);
    
    const configRow = db.prepare(`
      SELECT config_json FROM evaluation_configs WHERE id = ?
    `).get(row.config_id) as { config_json: string } | undefined;
    
    if (!configRow) {
      console.error('[IPC] Evaluation config not found:', row.config_id);
      throw new Error('Evaluation config not found');
    }
    
    console.log('[IPC] Found config, importing evaluator_v2...');
    const config: EvaluationConfig = JSON.parse(configRow.config_json);

    // Same key preflight the CLI has had all along. Without it, a new user who
    // pressed Start before setting a key watched every node turn red, the
    // footer read "Stopped: no candidates left", the cost read $0.00, and the
    // words "API key" appeared NOWHERE on screen — the real reason reached
    // only a console.error in the Logs panel, which is closed by default.
    const requiredProviders = new Set<string>(config.enabledModels.map(m => m.provider));
    requiredProviders.add(config.serviceModel.provider);
    // Only adapters that declare they need a key. A plugin provider may talk to
    // a local server (the shipped Ollama example does) and need none.
    const { getProviderAdapter } = await import('@promptengine/core');
    const needsKey = (p: string) => {
      try { return (getProviderAdapter(p as any) as any)?.requiresApiKey === true; } catch { return false; }
    };
    const missingKeys = [...requiredProviders].filter(p => needsKey(p) && !getApiKeySync(p));
    if (missingKeys.length > 0) {
      throw new Error(
        `No API key for ${missingKeys.join(', ')}. Open Settings → API Keys and add ${missingKeys.length > 1 ? 'them' : 'it'}, then start the run again.`,
      );
    }

    // The CLI's other resume guard, which this path was missing. A checkpoint
    // can reference a provider a PLUGIN registered; if that plugin is now
    // disabled or removed, the run does not fail — it grinds through every
    // remaining node with "Unknown provider", degenerates into cache-hit copies
    // of whichever node still had results, marks itself `finished`, and can
    // then never be resumed again. One click permanently burns the run.
    const { listProviders } = await import('@promptengine/core');
    const available = new Set(listProviders());
    const missingProviders = [...requiredProviders].filter(p => !available.has(p as any));
    if (missingProviders.length > 0) {
      throw new Error(
        `Provider not available: ${missingProviders.join(', ')}. ` +
        'It comes from a plugin that is not loaded — re-enable it in Settings → Plugins, then start the run again. ' +
        'The run is untouched and can still be resumed once the provider is back.',
      );
    }

    const { startEvaluation: startEval } = await import('@promptengine/core');
    console.log('[IPC] Calling engine startEvaluation (V2)...');
    await startEval(runId, config, run);
    console.log('[IPC] Engine startEvaluation (V2) completed');
  } catch (error) {
    console.error('[IPC] startEvaluation failed:', error);
    throw error;
  }
}

async function pauseEvaluation(runId: string): Promise<void> {
  const { pauseEvaluation: pauseEval } = await import('@promptengine/core');
  pauseEval(runId);
}

async function resumeEvaluation(runId: string): Promise<void> {
  const { resumeEvaluation: resumeEval } = await import('@promptengine/core');
  resumeEval(runId);
}

async function stopEvaluation(runId: string): Promise<void> {
  const { stopEvaluation: stopEval } = await import('@promptengine/core');
  stopEval(runId);
}

/**
 * Cached list summaries, keyed by run id. `len` is LENGTH(run_json) at the time
 * the summary was built: a finished run's blob never changes again, so after the
 * first poll it is never re-read or re-parsed.
 */
const summaryCache = new Map<string, { key: string; summary: EvaluationRun }>();

/**
 * Sidebar list rows: scalars plus a precomputed best score. NOT the full runs.
 *
 * This is polled every 2 seconds, forever, whether or not an evaluation is
 * running. Selecting and JSON.parsing every run_json made that poll cost
 * 1,442 ms with one large run on file and 2,335 ms across thirteen — longer
 * than its own interval, so the main process never idled — and shipped 312 MB
 * to the renderer on every tick, which React Query then cached. Reading lengths
 * instead of blobs means a poll re-parses only the run that actually changed.
 *
 * `generations` is deliberately EMPTY here. Use eval:get for the full run.
 */
async function listEvaluations(): Promise<EvaluationRun[]> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT r.id, LENGTH(r.run_json) as len,
           COALESCE(r.finished_at, 0) as fin, COALESCE(r.stop_reason, '') as stop,
           c.name as config_name
    FROM evaluation_runs r
    LEFT JOIN evaluation_configs c ON r.config_id = c.id
    ORDER BY r.started_at DESC
  `).all() as { id: string; len: number; fin: number; stop: string; config_name: string }[];

  const live = new Set(rows.map(r => r.id));
  for (const id of summaryCache.keys()) {
    if (!live.has(id)) summaryCache.delete(id); // deleted runs must not pin memory
  }

  const out: EvaluationRun[] = [];
  for (const row of rows) {
    // Length ALONE was the key, and equal-length rewrites are ordinary in this
    // schema: "running"/"stopped"/"pausing" are all 7 characters, stop reasons
    // "target"/"budget" both 6, and any metric edit that keeps its digit count
    // (fitness 3.1 -> 9.9) is invisible. A stale summary then survived for the
    // whole app session: the sidebar showed the wrong status, the wrong best
    // score and a wrong Resume badge. Fold in the columns persistRun writes.
    const rowKey = `${row.len}:${row.fin}:${row.stop}`;
    const cached = summaryCache.get(row.id);
    let summary: EvaluationRun;
    if (cached && cached.key === rowKey) {
      summary = cached.summary;
    } else {
      const blob = db.prepare('SELECT run_json FROM evaluation_runs WHERE id = ?')
        .get(row.id) as { run_json: string } | undefined;
      if (!blob) continue;
      // ONE try around parse AND the walk. The walk used to sit outside it, so
      // a run whose `generations` held a non-array element (`[{}]`, `[null]`,
      // `[5]` — all accepted by eval:import, which only checked the OUTER
      // array) threw "generation is not iterable" out of eval:list. The
      // sidebar polls that every 2s, so one bad import froze the list and, on
      // the next cold start, emptied it completely — including the poison row,
      // leaving no UI to delete it with. LeftSidebar is the one panel App.tsx
      // does not wrap in an ErrorBoundary.
      //
      // A run we cannot summarise still gets a ROW, so it stays visible and
      // deletable rather than vanishing.
      try {
        const run: EvaluationRun = JSON.parse(blob.run_json);
        let best = -Infinity;
        let nodeCount = 0;
        const generations = Array.isArray(run.generations) ? run.generations : [];
        for (const generation of generations) {
          if (!Array.isArray(generation)) continue;
          for (const node of generation) {
            nodeCount++;
            const f = node?.metrics?.fitness;
            if (typeof f === 'number' && f > best) best = f;
          }
        }
        const { generations: _drop, ...scalars } = run;
        summary = {
          ...scalars,
          generations: [],
          ...( { bestScore: Number.isFinite(best) ? best : null, generationCount: generations.length, nodeCount } as any ),
        } as EvaluationRun;
      } catch (error) {
        console.error(`[IPC] Run ${row.id.slice(0, 8)} could not be summarised:`, error);
        summary = {
          id: row.id, generations: [], startedAt: 0,
          totals: { tokensPrompt: 0, tokensCompletion: 0, usd: 0, calls: 0 },
          cacheHits: 0, version: 'unknown', status: 'stopped', stopReason: 'error',
          ...( { bestScore: null, generationCount: 0, nodeCount: 0, corrupt: true } as any ),
        } as unknown as EvaluationRun;
      }
      summaryCache.set(row.id, { key: rowKey, summary });
    }
    // Recomputed every poll: liveness is process state, not row state.
    out.push({
      ...summary,
      ...( { configName: row.config_name, interrupted: summary.status !== 'finished' && !isEvaluationActive(row.id) } as any ),
    } as EvaluationRun);
  }
  return out;
}

/** The FULL run, for the one evaluation the user actually opened. */
async function getEvaluation(runId: string): Promise<EvaluationRun | null> {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT r.run_json, c.name as config_name
    FROM evaluation_runs r
    LEFT JOIN evaluation_configs c ON r.config_id = c.id
    WHERE r.id = ?
  `).get(runId) as { run_json: string; config_name: string } | undefined;
  if (!row) return null;
  try {
    const run = JSON.parse(row.run_json) as EvaluationRun;
    (run as any).configName = row.config_name;
    (run as any).interrupted = run.status !== 'finished' && !isEvaluationActive(runId);
    return run;
  } catch {
    console.error(`[IPC] eval:get ${runId.slice(0, 8)}: unparseable run_json`);
    return null;
  }
}

async function deleteEvaluation(runId: string): Promise<void> {
  const db = getDatabase();

  // Stop the engine FIRST. Deleting a live run used to leave it running with no
  // UI to stop it: it kept making paid LLM calls, wrote checkpoints to a row
  // that no longer existed, and still ran the playoff and holdout passes.
  if (isEvaluationActive(runId)) {
    console.log(`[IPC] Stopping active evaluation ${runId.slice(0, 8)} before deleting it`);
    const { stopEvaluation } = await import('@promptengine/core');
    stopEvaluation(runId);
    // Give the engine a moment to unwind in-flight work before the rows vanish
    for (let i = 0; i < 50 && isEvaluationActive(runId); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Delete from all related tables in correct order (children first, then parents)
  const transaction = db.transaction(() => {
    // Get config_id before deleting the run
    const runRow = db.prepare('SELECT config_id FROM evaluation_runs WHERE id = ?').get(runId) as { config_id: string } | undefined;
    
    // Delete child tables first (all tables with FOREIGN KEY to evaluation_runs).
    // candidate_nodes was dropped in migration 5 — it was never written.
    db.prepare('DELETE FROM raw_blobs WHERE run_id = ?').run(runId);
    
    // Now delete the run itself
    db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(runId);
    
    // Finally, delete the config if no other runs reference it
    if (runRow) {
      const remainingRuns = db.prepare('SELECT COUNT(*) as count FROM evaluation_runs WHERE config_id = ?').get(runRow.config_id) as { count: number };
      if (remainingRuns.count === 0) {
        db.prepare('DELETE FROM evaluation_configs WHERE id = ?').run(runRow.config_id);
      }
    }
  });

  transaction();

  // Reclaim the space. sql.js leaves freed pages in the file, so deleting rows
  // alone does not shrink it — a 313 MB database stayed 313 MB after deleting
  // every run, and sql.js then loads and re-exports all of it on every save
  // (390 ms per whole-file write at that size). VACUUM cannot run inside a
  // transaction, hence out here. `--prune-runs` already does this.
  try {
    db.exec('VACUUM');
    db.flush();
  } catch (error) {
    console.warn('[IPC] VACUUM after delete failed (the row is still gone):', error);
  }

  // The deleted run's spend sidecar has nothing left to describe.
  try {
    const { clearSpend } = await import('@promptengine/core');
    clearSpend(db.dbPath, runId);
  } catch { /* best effort */ }

  summaryCache.delete(runId);
}

async function getEvaluationConfig(runId: string): Promise<EvaluationConfig | null> {
  const db = getDatabase();
  
  const row = db.prepare(`
    SELECT ec.config_json
    FROM evaluation_runs er
    JOIN evaluation_configs ec ON er.config_id = ec.id
    WHERE er.id = ?
  `).get(runId) as { config_json: string } | undefined;
  
  if (!row) {
    return null;
  }
  
  return JSON.parse(row.config_json);
}

// Returns null when the user cancels the save dialog. The declared type said
// `string`, and only coincidence kept it working: window.d.ts declares
// `Promise<string | null>` and the caller handles null, but nothing checked
// the two against each other until the main process was strict-typed.
async function exportEvaluation(runId: string): Promise<string | null> {
  const db = getDatabase();
  const fs = await import('fs');
  const path = await import('path');
  const { dialog, app } = await import('electron');
  
  // Get the run
  const runRow = db.prepare(`
    SELECT run_json, config_id FROM evaluation_runs WHERE id = ?
  `).get(runId) as { run_json: string; config_id: string } | undefined;
  
  if (!runRow) {
    throw new Error('Evaluation run not found');
  }
  
  const run: EvaluationRun = JSON.parse(runRow.run_json);
  
  // Get the config
  const configRow = db.prepare(`
    SELECT config_json FROM evaluation_configs WHERE id = ?
  `).get(runRow.config_id) as { config_json: string } | undefined;
  
  const config: EvaluationConfig = configRow ? JSON.parse(configRow.config_json) : null;
  
  // Get raw blobs if any
  const blobRows = db.prepare(`
    SELECT id, node_id, test_id, blob_data FROM raw_blobs WHERE run_id = ?
  `).all(runId) as any[];
  
  const exportData = {
    version: run.version,
    exportedAt: Date.now(),
    run,
    config,
    rawBlobs: blobRows.map(row => ({
      id: row.id,
      nodeId: row.node_id,
      testId: row.test_id,
      data: row.blob_data,
    })),
  };
  
  // Show save dialog
  const result = await dialog.showSaveDialog({
    title: 'Export Evaluation',
    defaultPath: path.join(app.getPath('documents'), `evaluation-${runId.substring(0, 8)}.json`),
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  });
  
  // Cancelling a save dialog is a normal choice, not an error. Throwing made
  // the renderer alert "Export failed: Error invoking remote method
  // 'eval:export': Error: Export canceled" at a user who simply pressed Cancel.
  if (result.canceled || !result.filePath) {
    return null;
  }
  
  // Write file
  fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2));
  
  return result.filePath;
}

async function importEvaluation(filePath: string): Promise<EvaluationRun> {
  const db = getDatabase();
  const fs = await import('fs');
  const { v4: uuidv4 } = await import('uuid');
  
  // Read file
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const importData = JSON.parse(fileContent);
  
  // Validate structure BEFORE touching the database. A shape check this loose
  // let a string, a number or an array through, which surfaced later as raw
  // sql.js text ("tried to bind a value of an unknown type") — or, worse, was
  // accepted: a truthy non-array `generations` reached CenterView's .reduce and
  // crashed the render on every subsequent open.
  const isPlainObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(importData) || !isPlainObject(importData.run) || !isPlainObject(importData.config)) {
    throw new Error('Invalid export file: expected an object with "run" and "config" objects.');
  }

  const run: EvaluationRun = importData.run;
  const config: EvaluationConfig = importData.config;

  if (!Array.isArray(run.generations)) {
    throw new Error('Invalid export file: "run.generations" must be an array.');
  }
  // Each generation must be an array too. Checking only the outer one let
  // `[{}]`, `[null]` and `[5]` through, and every later consumer iterates the
  // inner arrays — eval:list threw on each poll and took the whole sidebar
  // down with it.
  if (!run.generations.every(g => Array.isArray(g))) {
    throw new Error('Invalid export file: every entry in "run.generations" must itself be an array of nodes.');
  }
  // The SHAPE was checked and the CONTENTS were not, so a node with no
  // changeLog imported cleanly and then threw a TypeError on every open,
  // replacing the lineage graph with its ErrorBoundary for that run — reachable
  // from an ordinary older or hand-edited export, not just a hostile one. A
  // string `fitness` broke the graph the same way, and fabricated totals
  // (usd: -999.5, cacheHits: -5) rendered as fact.
  const nodes = (run.generations as any[]).flat();
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') {
      throw new Error('Invalid export file: every node must be an object with a string id.');
    }
    if (n.changeLog !== undefined && !Array.isArray(n.changeLog)) {
      throw new Error(`Invalid export file: node ${n.id} has a non-array changeLog.`);
    }
    const f = n.metrics?.fitness;
    if (f !== undefined && f !== null && (typeof f !== 'number' || !Number.isFinite(f))) {
      throw new Error(`Invalid export file: node ${n.id} has a non-numeric fitness (${JSON.stringify(f)}).`);
    }
  }
  for (const [field, value] of [['totals.usd', run.totals?.usd], ['cacheHits', run.cacheHits]] as const) {
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid export file: ${field} must be a non-negative number (got ${JSON.stringify(value)}).`);
    }
  }

  if (typeof run.startedAt !== 'number' || !run.version) {
    throw new Error('Invalid export file: "run" is missing startedAt or version.');
  }
  if (typeof config.name !== 'string') {
    throw new Error('Invalid export file: "config.name" must be a string.');
  }
  if (importData.rawBlobs !== undefined && !Array.isArray(importData.rawBlobs)) {
    throw new Error('Invalid export file: "rawBlobs" must be an array.');
  }

  // Generate new IDs to avoid conflicts
  const newConfigId = uuidv4();
  const newRunId = uuidv4();
  
  config.id = newConfigId;
  run.id = newRunId;
  run.configId = newConfigId;
  
  // All three inserts in one transaction. Unwrapped, a run or blob that failed
  // to insert left the config row committed, so every failed import added
  // another orphan "… (imported)" entry the user could not see or remove.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO evaluation_configs (id, name, config_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      config.id,
      config.name + ' (imported)',
      JSON.stringify(config),
      Date.now()
    );

    db.prepare(`
      INSERT INTO evaluation_runs (id, config_id, started_at, finished_at, stop_reason, run_json, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.configId,
      run.startedAt,
      run.finishedAt || null,
      run.stopReason || null,
      JSON.stringify(run),
      run.version
    );

    if (importData.rawBlobs && importData.rawBlobs.length > 0) {
      const blobInsert = db.prepare(`
        INSERT INTO raw_blobs (id, run_id, node_id, test_id, blob_data, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const blob of importData.rawBlobs) {
        blobInsert.run(
          uuidv4(),
          run.id,
          blob.nodeId ?? null,
          blob.testId ?? null,
          blob.data ?? null,
          Date.now()
        );
      }
    }
  })();

  return run;
}

async function getSettings(): Promise<AppSettings> {
  try {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT value FROM app_settings WHERE key = 'app_settings'
    `).get() as { value: string } | undefined;
    
    if (row) {
      const settings = JSON.parse(row.value);

      // Auto-fix: If service model is empty, select first available model.
      // Optional chaining is load-bearing: a stored row without `serviceModel`
      // threw here, and the outer catch then fell through to the defaults block
      // — which WRITES those defaults over the user's real settings.
      if (!settings.serviceModel?.model || settings.serviceModel.model === '') {
        const firstModel = db.prepare(`
          SELECT provider, model FROM model_costs LIMIT 1
        `).get() as { provider: string; model: string } | undefined;
        
        if (firstModel) {
          settings.serviceModel = { 
            provider: firstModel.provider as any, 
            model: firstModel.model 
          };
          // Save the fixed settings (merge, never replace the stored row)
          await setSettings({ ...settings });
          console.log(`[Settings] Auto-selected first available model: ${firstModel.provider}/${firstModel.model}`);
        }
      }
      
      return settings;
    }
  } catch (error) {
    console.error('Error getting settings from database:', error);
  }
  
  // Default settings - try to select first available model
  const db = getDatabase();
  const firstModel = db.prepare(`
    SELECT provider, model FROM model_costs LIMIT 1
  `).get() as { provider: string; model: string } | undefined;
  
  const defaultSettings: AppSettings = {
    globalParallelLimit: 5,
    serviceModel: firstModel 
      ? { provider: firstModel.provider as any, model: firstModel.model }
      : { provider: 'openai', model: 'gpt-4o-mini' }, // Fallback
    serviceModelMaxTokens: 20000, // Default 20k tokens for ALL model calls (service + candidate)
    retries: 3, // Default 3 retries for JSON parsing failures
  };
  
  // Save defaults so they persist
  try {
    await setSettings(defaultSettings);
    console.log(`[Settings] Initialized with default model: ${defaultSettings.serviceModel.provider}/${defaultSettings.serviceModel.model}`);
  } catch (error) {
    console.error('[Settings] Failed to save default settings:', error);
  }
  
  return defaultSettings;
}

async function setSettings(rawSettings: AppSettings): Promise<void> {
  const settings = validateSettings(rawSettings);
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value)
      VALUES ('app_settings', ?)
    `).run(JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving settings to database:', error);
    throw error;
  }
}

/**
 * Mask a key for logging. `'***' + key.slice(-4)` logs a key of 4 characters or
 * fewer in FULL — slice(-4) of a short string is the whole string.
 */
function maskKey(key: string | undefined): string {
  if (!key) return 'EMPTY';
  return key.length > 8 ? `***${key.slice(-4)}` : '***';
}

async function saveApiKey(provider: string, key: string): Promise<void> {
  // The store key is built by interpolation, so an arbitrary provider string
  // wrote junk entries like `apiKey.../../etc` and `apiKey.__proto__` into the
  // store the CLI also reads. Providers are a known, small set.
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(provider)) {
    throw new Error(`Invalid provider name: ${JSON.stringify(provider)}`);
  }
  try {
    console.log(`[Handlers] Saving API key for ${provider} as: apiKey.${provider}, value: ${maskKey(key)}`);
    if (key && key.trim()) {
      store.set(`apiKey.${provider}`, key);
    } else {
      // Delete the key if empty
      store.delete?.(`apiKey.${provider}`);
      console.log(`[Handlers] Deleted empty key for ${provider}`);
    }
    console.log(`[Handlers] All keys in store:`, Object.keys(store.store));
  } catch (error) {
    console.error(`Error saving API key for ${provider}:`, error);
    throw error;
  }
}

/** Synchronous key read, for the preflight in startEvaluation. */
function getApiKeySync(provider: string): string | null {
  try {
    const key = store.get(`apiKey.${provider}`, null) as string | null;
    return key && key.trim() ? key : null;
  } catch {
    return null;
  }
}

async function getApiKey(provider: string): Promise<string | null> {
  try {
    return store.get(`apiKey.${provider}`, null) as string | null;
  } catch (error) {
    console.error(`Error getting API key for ${provider}:`, error);
    return null;
  }
}

async function testApiKey(provider: string): Promise<boolean> {
  const key = await getApiKey(provider);
  if (!key) return false;
  
  try {
    // Test with minimal API call
    switch (provider) {
      case 'openai':
        const openaiResponse = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        return openaiResponse.ok;
        
      case 'anthropic':
        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku',
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 1,
          }),
        });
        // 400 is ok (bad request but auth worked), 401/403 means bad key
        return anthropicResponse.status !== 401 && anthropicResponse.status !== 403;
        
      case 'gemini':
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models`,
          {
            headers: {
              'x-goog-api-key': key,
            },
          }
        );
        return geminiResponse.ok;

      case 'openrouter':
        const openrouterResponse = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        return openrouterResponse.ok;

      case 'groq': {
        // Groq had no branch here at all, so keys:test('groq') returned false
        // even with a valid key — while Groq stayed selectable in two dropdowns.
        const groqResponse = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        return groqResponse.ok;
      }

      default:
        return false;
    }
  } catch (error) {
    console.error('API key test failed:', error);
    return false;
  }
}

async function getModelCost(modelRef: ModelRef): Promise<ModelCostEntry | null> {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT provider, model, prompt_usd_per_1k, completion_usd_per_1k
    FROM model_costs
    WHERE provider = ? AND model = ?
  `).get(modelRef.provider, modelRef.model) as any;
  
  if (!row) return null;
  
  return {
    provider: row.provider,
    model: row.model,
    promptUSDper1k: row.prompt_usd_per_1k,
    completionUSDper1k: row.completion_usd_per_1k,
  };
}

/**
 * Reject anything that would poison the cost table.
 *
 * The handler accepted anything: a string price was stored verbatim into a
 * REAL NOT NULL column and read back as a string, Infinity round-tripped as
 * null, and a NEGATIVE price inverts fitness and disarms the budget cap. The
 * CLI and the estimator read this same table.
 */
function validateModelCost(entry: ModelCostEntry): void {
  if (!entry || typeof entry.provider !== 'string' || !entry.provider || typeof entry.model !== 'string' || !entry.model) {
    throw new Error('Model cost entry needs a non-empty provider and model');
  }
  for (const field of ['promptUSDper1k', 'completionUSDper1k'] as const) {
    const value = entry[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Model cost "${field}" must be a finite number >= 0 (got ${JSON.stringify(value)})`);
    }
  }
}

async function setModelCost(entry: ModelCostEntry): Promise<void> {
  validateModelCost(entry);
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `).run(entry.provider, entry.model, entry.promptUSDper1k, entry.completionUSDper1k);
}

/**
 * Write many cost rows in ONE transaction.
 *
 * Settings' Save looped `costs.set` per row, so after an OpenRouter sync that
 * was 300+ separate IPC round-trips, each validating, writing and scheduling
 * its own whole-file save — with the Save button live throughout.
 */
async function setModelCosts(entries: ModelCostEntry[]): Promise<void> {
  if (!Array.isArray(entries)) throw new Error('costs:setMany expects an array');
  for (const entry of entries) validateModelCost(entry);
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const entry of entries) {
      insert.run(entry.provider, entry.model, entry.promptUSDper1k, entry.completionUSDper1k);
    }
  })();
}

async function getAllModelCosts(): Promise<ModelCostEntry[]> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT provider, model, prompt_usd_per_1k, completion_usd_per_1k
    FROM model_costs
  `).all() as any[];
  
  return rows.map(row => ({
    provider: row.provider,
    model: row.model,
    promptUSDper1k: row.prompt_usd_per_1k,
    completionUSDper1k: row.completion_usd_per_1k,
  }));
}

async function getSystemPrompts(): Promise<any | null> {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    return prompts;
  } catch (error) {
    console.error('Error getting system prompts:', error);
    return null;
  }
}

async function setSystemPrompts(prompts: any): Promise<void> {
  try {
    store.set('systemPrompts', prompts);
  } catch (error) {
    console.error('Error saving system prompts:', error);
    throw error;
  }
}

async function fetchOpenRouterModels(): Promise<Array<{
  id: string;
  name: string;
  promptUSDper1k: number;
  completionUSDper1k: number;
}>> {
  const apiKey = store.get('apiKey.openrouter', null) as string | null;
  return OpenRouterAdapter.fetchModels(apiKey ?? undefined);
}

async function syncOpenRouterModels(): Promise<{ count: number }> {
  const models = await fetchOpenRouterModels();
  const db = getDatabase();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES ('openrouter', ?, ?, ?)
  `);

  const insertMany = db.transaction((items: typeof models) => {
    for (const m of items) {
      upsert.run(m.id, m.promptUSDper1k, m.completionUSDper1k);
    }
  });

  insertMany(models);
  console.log(`[OpenRouter] Synced ${models.length} models to database`);
  return { count: models.length };
}

