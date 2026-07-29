/**
 * Durable running total of what a run has actually spent.
 *
 * WHY THIS EXISTS, separately from the checkpoint:
 *
 * `run.totals` and `run.costBreakdown` live inside `run_json`, which is written
 * by `persistRun`. That write serialises the WHOLE run — every node of every
 * generation with every test output — so it cannot run on every call; it is
 * paced against its own cost. Everything billed between the last checkpoint and
 * a crash is therefore rolled back in the accounting but NOT in the provider's
 * billing, and since `budgetUSD` is enforced against `run.totals.usd`, every
 * crash/resume cycle re-armed the whole budget. Measured across 8 SIGKILL and
 * resume cycles with a $0.0060 cap: 114 calls really billed, $0.0114 spent, the
 * run reporting 62 calls and `stopReason: budget`.
 *
 * A sidecar fixes it cheaply. This file holds only the cost totals — around a
 * kilobyte, no matter how large the run — so it can be rewritten on every
 * accrual without the quadratic cost that makes the checkpoint expensive.
 *
 * It is advisory, never authoritative for anything but MONEY: on resume the
 * larger of (checkpoint, sidecar) wins, so a stale or missing sidecar can only
 * under-report, never invent spend.
 *
 * WHAT IT STILL CANNOT RECOVER: calls that were IN FLIGHT at the instant of the
 * crash. `accrueCost` runs after a call returns, so a request the provider has
 * already served but not yet answered has no entry anywhere. That residue is
 * bounded by the number of concurrent calls. Measured on a crash at call 50:
 * checkpoint 35, sidecar 41, really billed 50 — the sidecar recovered 6 of the
 * 15 lost, and the remaining 9 were in flight. (9 rather than `parallelLimit`
 * because that harness used a plain-object plugin adapter, which does not go
 * through BaseProviderAdapter's global semaphore.)
 */
import fs from 'fs';
import path from 'path';

export interface SpendSnapshot {
  runId: string;
  totals: { tokensPrompt: number; tokensCompletion: number; usd: number; calls: number };
  costBreakdown?: Record<string, { calls: number; promptTokens: number; completionTokens: number; usd: number }>;
  /** Wall clock of the last write, for the resume message. */
  at: number;
}

function ledgerPath(dbPath: string, runId: string): string {
  return path.join(path.dirname(dbPath), `.spend-${runId}.json`);
}

/**
 * Overwrite the run's spend sidecar. Never throws: losing the ledger degrades
 * accounting, but failing a run because a sidecar could not be written would be
 * worse than the problem it solves.
 */
export function recordSpend(dbPath: string, snapshot: SpendSnapshot): void {
  try {
    const target = ledgerPath(dbPath, snapshot.runId);
    // Write-then-rename: a torn 1 KB file would otherwise read as corrupt and
    // silently discard the whole correction on resume.
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, target);
  } catch { /* advisory only */ }
}

/** The sidecar for this run, or null when absent or unreadable. */
export function readSpend(dbPath: string, runId: string): SpendSnapshot | null {
  try {
    const raw = fs.readFileSync(ledgerPath(dbPath, runId), 'utf8');
    const parsed = JSON.parse(raw) as SpendSnapshot;
    if (!parsed || typeof parsed.totals?.usd !== 'number' || !Number.isFinite(parsed.totals.usd)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the sidecar once the run is finished and its checkpoint is authoritative. */
export function clearSpend(dbPath: string, runId: string): void {
  try {
    fs.rmSync(ledgerPath(dbPath, runId), { force: true });
    fs.rmSync(`${ledgerPath(dbPath, runId)}.tmp`, { force: true });
  } catch { /* best effort */ }
}
