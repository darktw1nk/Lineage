import { describe, it, expect } from 'vitest';
import { holdoutTile } from '../../src/utils/holdoutTile';

/**
 * Open-bugs 2026-07-31 #7/#8. Footer.tsx rendered the Holdout tile only when
 * BOTH halves scored — so a budget stop, a missing champion, a manual stop, a
 * circuit-breaker abort, and a half-finished holdout all rendered NOTHING,
 * making "no tile" ambiguous between "no holdout configured" and "configured
 * but it did not run". And when both halves DID score, numbers fabricated by a
 * failed judge (placeholder rows) were indistinguishable from measurements.
 */
const half = (score: number, ungraded = false) => ({
  score,
  perTest: [{ testId: 'h1', score, ...(ungraded ? { ungraded: true } : {}) }],
});

describe('holdoutTile', () => {
  it('renders nothing when no holdout was configured', () => {
    expect(holdoutTile(undefined)).toBeNull();
  });

  it('shows the measured pair when both halves scored cleanly', () => {
    const tile = holdoutTile({
      testIds: ['h1'], samplesPerTest: 1,
      seed: half(6), champion: half(4),
    } as any)!;
    expect(tile.value).toBe('6.00 → 4.00');
    expect(tile.warn).toBe(false);
  });

  it('marks contaminated numbers when a holdout row could not be graded (bug 8)', () => {
    const tile = holdoutTile({
      testIds: ['h1'], samplesPerTest: 1,
      seed: half(0, true), champion: half(5),
    } as any)!;
    expect(tile.value).toContain('0.00 → 5.00');
    expect(tile.warn).toBe(true);
    expect(tile.title).toMatch(/could not be graded/i);
  });

  it('says WHY when the holdout was skipped (bug 7)', () => {
    for (const reason of ['budget', 'no-champion', 'manual', 'error', 'time'] as const) {
      const tile = holdoutTile({ testIds: ['h1'], samplesPerTest: 1, skipped: reason } as any)!;
      expect(tile).not.toBeNull();
      expect(tile.value).toContain(reason);
      expect(tile.warn).toBe(true);
    }
  });

  it('shows an incomplete holdout instead of hiding the half that WAS measured', () => {
    const champOnly = holdoutTile({ testIds: ['h1'], samplesPerTest: 1, champion: half(4) } as any)!;
    expect(champOnly.value).toBe('— → 4.00');
    expect(champOnly.warn).toBe(true);
    expect(champOnly.title).toMatch(/incomplete/i);

    const seedOnly = holdoutTile({ testIds: ['h1'], samplesPerTest: 1, seed: half(6) } as any)!;
    expect(seedOnly.value).toBe('6.00 → —');
    expect(seedOnly.warn).toBe(true);
  });

  it('distinguishes "configured but never ran" from "not configured"', () => {
    const tile = holdoutTile({ testIds: ['h1'], samplesPerTest: 1 } as any)!;
    expect(tile).not.toBeNull();
    expect(tile.value).toMatch(/did not run/i);
    expect(tile.warn).toBe(true);
  });

  it('surfaces a holdoutShare that rounded down to zero tests', () => {
    const tile = holdoutTile(undefined, 'share-rounds-to-zero')!;
    expect(tile).not.toBeNull();
    expect(tile.warn).toBe(true);
    expect(tile.title).toMatch(/zero held-out tests/i);
  });
});
