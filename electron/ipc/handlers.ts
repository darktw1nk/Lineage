import { IpcMain } from 'electron';
import type { EvaluationConfig, EvaluationRun, ModelRef, ModelCostEntry, AppSettings } from '../../src/types/index.js';
import { getDatabase } from '../database/init.js';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store.js';
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
  
  ipcMain.handle('keys:debug', async () => {
    return {
      allKeys: Object.keys(store.store),
      allData: store.store,
    };
  });
  
  // Cost table handlers
  ipcMain.handle('costs:get', async (_event, modelRef: ModelRef) => {
    return getModelCost(modelRef);
  });
  
  ipcMain.handle('costs:set', async (_event, entry: ModelCostEntry) => {
    return setModelCost(entry);
  });
  
  ipcMain.handle('costs:getAll', async () => {
    return getAllModelCosts();
  });
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
  
  const runInsert = db.prepare(`
    INSERT INTO evaluation_runs (id, config_id, started_at, run_json, version)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  runInsert.run(
    run.id,
    run.configId,
    run.startedAt,
    JSON.stringify(run),
    run.version
  );
  
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
    
    const { startEvaluation: startEval } = await import('../engine/evaluator_v2.js');
    console.log('[IPC] Calling engine startEvaluation (V2)...');
    await startEval(runId, config, run);
    console.log('[IPC] Engine startEvaluation (V2) completed');
  } catch (error) {
    console.error('[IPC] startEvaluation failed:', error);
    throw error;
  }
}

async function pauseEvaluation(runId: string): Promise<void> {
  const { pauseEvaluation: pauseEval } = await import('../engine/evaluator_v2.js');
  pauseEval(runId);
}

async function resumeEvaluation(runId: string): Promise<void> {
  const { resumeEvaluation: resumeEval } = await import('../engine/evaluator_v2.js');
  resumeEval(runId);
}

async function stopEvaluation(runId: string): Promise<void> {
  const { stopEvaluation: stopEval } = await import('../engine/evaluator_v2.js');
  stopEval(runId);
}

async function listEvaluations(): Promise<EvaluationRun[]> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT r.run_json, c.name as config_name 
    FROM evaluation_runs r
    LEFT JOIN evaluation_configs c ON r.config_id = c.id
    ORDER BY r.started_at DESC
  `).all() as { run_json: string; config_name: string }[];
  
  return rows.map(row => {
    const run = JSON.parse(row.run_json);
    // Add the config name to the run object for display
    (run as any).configName = row.config_name;
    return run;
  });
}

async function deleteEvaluation(runId: string): Promise<void> {
  const db = getDatabase();
  
  // Delete from all related tables in correct order (children first, then parents)
  const transaction = db.transaction(() => {
    // Get config_id before deleting the run
    const runRow = db.prepare('SELECT config_id FROM evaluation_runs WHERE id = ?').get(runId) as { config_id: string } | undefined;
    
    // Delete child tables first (all tables with FOREIGN KEY to evaluation_runs)
    db.prepare('DELETE FROM candidate_nodes WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM raw_blobs WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM cost_ledger WHERE run_id = ?').run(runId);
    
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

async function exportEvaluation(runId: string): Promise<string> {
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
  
  if (result.canceled || !result.filePath) {
    throw new Error('Export canceled');
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
  
  // Validate structure
  if (!importData.run || !importData.config) {
    throw new Error('Invalid export file format');
  }
  
  const run: EvaluationRun = importData.run;
  const config: EvaluationConfig = importData.config;
  
  // Generate new IDs to avoid conflicts
  const newConfigId = uuidv4();
  const newRunId = uuidv4();
  
  config.id = newConfigId;
  run.id = newRunId;
  run.configId = newConfigId;
  
  // Insert config
  db.prepare(`
    INSERT INTO evaluation_configs (id, name, config_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    config.id,
    config.name + ' (imported)',
    JSON.stringify(config),
    Date.now()
  );
  
  // Insert run
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
  
  // Insert raw blobs if any
  if (importData.rawBlobs && importData.rawBlobs.length > 0) {
    const blobInsert = db.prepare(`
      INSERT INTO raw_blobs (id, run_id, node_id, test_id, blob_data, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    for (const blob of importData.rawBlobs) {
      blobInsert.run(
        uuidv4(),
        run.id,
        blob.nodeId,
        blob.testId,
        blob.data,
        Date.now()
      );
    }
  }
  
  return run;
}

async function getSettings(): Promise<AppSettings> {
  try {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT value FROM app_settings WHERE key = 'app_settings'
    `).get() as { value: string } | undefined;
    
    if (row) {
      return JSON.parse(row.value);
    }
  } catch (error) {
    console.error('Error getting settings from database:', error);
  }
  
  // Default settings - user must configure service model
  return {
    globalParallelLimit: 5,
    serviceModel: { provider: 'openai', model: '' },
    serviceModelMaxTokens: 20000, // Default 20k tokens for ALL model calls (service + candidate)
  };
}

async function setSettings(settings: AppSettings): Promise<void> {
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

async function saveApiKey(provider: string, key: string): Promise<void> {
  try {
    console.log(`[Handlers] Saving API key for ${provider} as: apiKey.${provider}, value: ${key ? '***' + key.slice(-4) : 'EMPTY'}`);
    if (key && key.trim()) {
      store.set(`apiKey.${provider}`, key);
    } else {
      // Delete the key if empty
      store.delete(`apiKey.${provider}`);
      console.log(`[Handlers] Deleted empty key for ${provider}`);
    }
    console.log(`[Handlers] All keys in store:`, Object.keys(store.store));
  } catch (error) {
    console.error(`Error saving API key for ${provider}:`, error);
    throw error;
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
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
        );
        return geminiResponse.ok;
        
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

async function setModelCost(entry: ModelCostEntry): Promise<void> {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO model_costs (provider, model, prompt_usd_per_1k, completion_usd_per_1k)
    VALUES (?, ?, ?, ?)
  `).run(entry.provider, entry.model, entry.promptUSDper1k, entry.completionUSDper1k);
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

