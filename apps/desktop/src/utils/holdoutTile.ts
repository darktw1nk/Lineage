import type { EvaluationRun } from '../types';

/**
 * What the Footer's Holdout tile should display.
 *
 * Open-bugs 2026-07-31 #7/#8: the tile used to render only when BOTH holdout
 * halves had scored, so every failure mode (budget stop, no champion, manual
 * stop, circuit-breaker abort, one half finished before a stop) rendered
 * nothing — "no tile" was ambiguous between "no holdout configured" and
 * "configured but it did not run". The CLI report distinguishes these; the
 * desktop must too. And a score pair containing ungraded placeholder rows was
 * shown bare, indistinguishable from a measurement.
 */
export interface HoldoutTileModel {
  /** The text shown in the tile, e.g. "6.00 → 4.00" or "skipped: budget". */
  value: string;
  /** When true, render in the warning style with a ⚠️ mark. */
  warn: boolean;
  /** Hover text explaining the state. */
  title: string;
}

const SKIP_EXPLANATIONS: Record<string, string> = {
  budget: 'The budget was exhausted before the holdout could run.',
  'no-champion': 'No champion finished, so there was nothing to score against the seed.',
  manual: 'The run was stopped manually before the holdout ran.',
  error: 'The run was aborted (grading circuit breaker) — the holdout would have been judged by the same broken judge.',
  time: 'The time limit was reached before the holdout could run.',
};

export function holdoutTile(
  holdout: EvaluationRun['holdout'],
  holdoutSkippedReason?: EvaluationRun['holdoutSkippedReason'],
): HoldoutTileModel | null {
  if (!holdout) {
    if (holdoutSkippedReason === 'share-rounds-to-zero') {
      return {
        value: 'not run',
        warn: true,
        title: 'holdoutShare rounded down to zero held-out tests — no generalization check ran. ' +
          'Add more tests, raise holdoutShare, or mark a test as Holdout explicitly.',
      };
    }
    return null; // genuinely not configured
  }

  if (holdout.skipped) {
    return {
      value: `skipped: ${holdout.skipped}`,
      warn: true,
      title: SKIP_EXPLANATIONS[holdout.skipped] ?? 'The holdout evaluation was skipped.',
    };
  }

  const { seed, champion } = holdout;
  if (seed && champion) {
    const ungradedRows = [seed, champion]
      .flatMap(h => (h.perTest ?? []) as Array<{ ungraded?: boolean }>)
      .filter(row => row?.ungraded).length;
    const value = `${seed.score.toFixed(2)} → ${champion.score.toFixed(2)}`;
    if (ungradedRows > 0) {
      return {
        value,
        warn: true,
        title: `${ungradedRows} holdout row(s) could not be graded and score 0 as placeholders — ` +
          'these numbers are not a measured comparison. The judge\'s reply was unreadable for those rows.',
      };
    }
    return {
      value,
      warn: false,
      title: `Seed vs champion on ${holdout.testIds.length} test(s) evolution never saw.`,
    };
  }

  if (seed || champion) {
    const value = `${seed ? seed.score.toFixed(2) : '—'} → ${champion ? champion.score.toFixed(2) : '—'}`;
    return {
      value,
      warn: true,
      title: `The holdout is incomplete — only the ${champion ? 'champion' : 'seed'} was scored ` +
        'before the run ended. The pair cannot be compared.',
    };
  }

  return {
    value: 'did not run',
    warn: true,
    title: 'A holdout was configured but never evaluated — the run ended before it could start.',
  };
}
