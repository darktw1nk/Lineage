/**
 * Run-history maintenance: archive runs to JSON, and prune old ones.
 *
 * Every database save is a whole-file export, so its cost scales with
 * ACCUMULATED HISTORY rather than the run being written — measured 13ms at
 * 1.3MB and 80ms at 50MB. Save pacing bounds the overhead, but only removing
 * history actually reverses the growth, and until now nothing could: the
 * desktop deletes one run at a time and the CLI had no way at all.
 */

export interface ArchiveResult {
  archived: Array<{ runId: string; file: string; bytes: number }>;
  skipped: Array<{ runId: string; reason: string }>;
}

export interface PruneResult {
  deleted: string[];
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
}

interface RunRow {
  id: string;
  config_id: string;
  started_at: number;
  run_json: string;
  version: string;
}

/** Runs newest-first, so "keep N" means "keep the N most recent". */
function listRunsNewestFirst(db: any): RunRow[] {
  return db.prepare(`
    SELECT id, config_id, started_at, run_json, version
    FROM evaluation_runs
    ORDER BY started_at DESC
  `).all() as RunRow[];
}

/**
 * Write every run to `<dir>/<runId>.json` in the same shape eval:export uses,
 * so an archived run can be imported back into the desktop app.
 */
export async function archiveRuns(db: any, dir: string): Promise<ArchiveResult> {
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(dir, { recursive: true });

  const result: ArchiveResult = { archived: [], skipped: [] };

  for (const row of listRunsNewestFirst(db)) {
    try {
      const cfgRow = db.prepare('SELECT config_json FROM evaluation_configs WHERE id = ?').get(row.config_id) as
        { config_json: string } | undefined;
      if (!cfgRow) {
        // Import requires both halves; a run whose config is gone cannot be
        // restored, so say so rather than writing a file that will not load.
        result.skipped.push({ runId: row.id, reason: 'its config row is missing' });
        continue;
      }
      const rawBlobs = db.prepare('SELECT node_id, test_id, blob_data FROM raw_blobs WHERE run_id = ?').all(row.id);
      const payload = {
        run: JSON.parse(row.run_json),
        config: JSON.parse(cfgRow.config_json),
        rawBlobs: (rawBlobs as any[]).map(b => ({ nodeId: b.node_id, testId: b.test_id, data: b.blob_data })),
        exportedAt: Date.now(),
      };
      const file = path.join(dir, `${row.id}.json`);
      const text = JSON.stringify(payload, null, 2);
      fs.writeFileSync(file, text);
      result.archived.push({ runId: row.id, file, bytes: Buffer.byteLength(text) });
    } catch (error) {
      result.skipped.push({ runId: row.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}

/**
 * Keep the `keep` most recent runs and delete the rest, then VACUUM.
 *
 * VACUUM matters: sql.js leaves freed pages in the file, so deleting rows alone
 * does not shrink it and the save cost stays exactly where it was.
 */
export async function pruneRuns(db: any, keep: number, dbPath: string): Promise<PruneResult> {
  const fs = await import('fs');
  const bytesBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

  const runs = listRunsNewestFirst(db);
  const doomed = runs.slice(Math.max(0, keep));
  const deleted: string[] = [];

  if (doomed.length > 0) {
    // One transaction: a half-finished prune would leave orphaned blobs and
    // configs behind, which is the mess this exists to clean up.
    db.transaction(() => {
      for (const row of doomed) {
        db.prepare('DELETE FROM raw_blobs WHERE run_id = ?').run(row.id);
        db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(row.id);
        // Only drop the config if no surviving run still points at it — the
        // desktop reuses a config when you re-run an evaluation.
        const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs WHERE config_id = ?')
          .get(row.config_id) as { n: number };
        if (stillUsed.n === 0) {
          db.prepare('DELETE FROM evaluation_configs WHERE id = ?').run(row.config_id);
        }
        deleted.push(row.id);
      }
    })();

    db.exec('VACUUM');
    db.flush();
  }

  const bytesAfter = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  return { deleted, kept: Math.min(keep, runs.length), bytesBefore, bytesAfter };
}
