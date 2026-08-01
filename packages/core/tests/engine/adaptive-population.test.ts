import { describe, it, expect } from 'vitest';
import { adaptiveGenerationSize } from '../../src/engine/generation.js';

/**
 * Adaptive population size.
 *
 * `generationSize` is fixed for the whole run, so a run that is improving fast
 * explores at the same width as one that stopped improving three generations
 * ago — and both cost the same per generation. Classic adaptive GAs size the
 * population to the progress rate: widen while the search is paying off,
 * narrow when it is not, so the budget follows the returns.
 *
 * Rules, each one a way this could go wrong:
 *  - OFF by default. Without `populationRange` the configured size is used
 *    exactly, forever.
 *  - Bounded on both sides. It can never grow past the user's ceiling — that
 *    ceiling is a spend control, not a suggestion — nor shrink below a floor
 *    where a "generation" stops being a population at all.
 *  - It needs evidence: with no history it uses the configured size rather
 *    than guessing.
 *  - Shrinking on a plateau must not fight `restartAfter`, which needs room to
 *    inject immigrants — so the floor is never below 2.
 */
const hist = (...best: number[]) => best;

describe('adaptive sizing is off unless a range is configured', () => {
  it('returns the configured size when no range is given', () => {
    expect(adaptiveGenerationSize(hist(1, 5, 9), 6, undefined)).toBe(6);
  });

  it('returns the configured size when the range is malformed', () => {
    expect(adaptiveGenerationSize(hist(1, 5, 9), 6, { min: 8, max: 4 })).toBe(6);
    expect(adaptiveGenerationSize(hist(1, 5, 9), 6, { min: NaN, max: 10 } as any)).toBe(6);
  });
});

describe('it widens the search while progress is real', () => {
  it('grows above the configured size on strong improvement', () => {
    const n = adaptiveGenerationSize(hist(2, 5, 8), 6, { min: 4, max: 12 });
    expect(n).toBeGreaterThan(6);
  });

  it('never exceeds the ceiling, however fast progress is', () => {
    const n = adaptiveGenerationSize(hist(0, 5, 10), 6, { min: 4, max: 8 });
    expect(n).toBeLessThanOrEqual(8);
  });
});

describe('it narrows when the search stops paying', () => {
  it('shrinks below the configured size on a plateau', () => {
    const n = adaptiveGenerationSize(hist(8, 8, 8), 6, { min: 3, max: 12 });
    expect(n).toBeLessThan(6);
  });

  it('never drops below the floor', () => {
    const n = adaptiveGenerationSize(hist(8, 8, 8, 8, 8), 6, { min: 5, max: 12 });
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('never drops below 2 even if the floor asks for less', () => {
    // A "generation" of 1 cannot breed, and restartAfter needs room for an
    // immigrant beside an elite. Needs a small configured size: shrinking is
    // halfway to the floor, so from 6 it cannot reach 1 in one step and a
    // larger size would pass this even with no clamp at all.
    const n = adaptiveGenerationSize(hist(8, 8, 8, 8), 2, { min: 0, max: 12 });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

/**
 * A user can configure `generationSize` outside their own `populationRange` —
 * nothing stops them. The range must still win, in both directions: it is the
 * spend control, and a size outside it was never sanctioned.
 */
describe('the range wins over a configured size that contradicts it', () => {
  it('pulls an oversized configured size down to the ceiling while improving', () => {
    expect(adaptiveGenerationSize(hist(0, 5, 10), 20, { min: 4, max: 8 })).toBe(8);
  });

  it('pulls an oversized configured size down to the ceiling on a plateau', () => {
    expect(adaptiveGenerationSize(hist(8, 8, 8), 20, { min: 4, max: 8 })).toBe(8);
  });

  it('lifts an undersized configured size up to the floor', () => {
    expect(adaptiveGenerationSize(hist(8, 8, 8), 2, { min: 5, max: 9 })).toBe(5);
  });
});

describe('it does not act on evidence it does not have', () => {
  it('uses the configured size with no history', () => {
    expect(adaptiveGenerationSize(hist(), 6, { min: 3, max: 12 })).toBe(6);
  });

  it('uses the configured size after a single generation', () => {
    expect(adaptiveGenerationSize(hist(5), 6, { min: 3, max: 12 })).toBe(6);
  });

  it('always returns a whole number of candidates', () => {
    for (const h of [hist(1, 4), hist(3, 3), hist(0, 9, 9.5)]) {
      const n = adaptiveGenerationSize(h, 7, { min: 3, max: 11 });
      expect(Number.isInteger(n), `history ${h.join(',')} gave ${n}`).toBe(true);
    }
  });
});
