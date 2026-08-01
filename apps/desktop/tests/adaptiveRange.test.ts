import { describe, it, expect } from 'vitest';
import { nextPopulationRange, isActiveRange, adaptiveRangeHint } from '../src/utils/adaptiveRange';

/**
 * The form has to survive being half-typed.
 *
 * The engine disables adaptive sizing on an incomplete or contradictory range,
 * silently. If the form let that state through as if it were configured, the
 * user would set "min 4", get fixed sizing, and never be told why — the exact
 * class of quiet no-op this project keeps finding in bug hunts.
 */
describe('editing one half of the range', () => {
  it('keeps the other half while a value is typed', () => {
    expect(nextPopulationRange({ min: 4 }, 'max', '12')).toEqual({ min: 4, max: 12 });
    expect(nextPopulationRange({ max: 12 }, 'min', '4')).toEqual({ min: 4, max: 12 });
  });

  it('turns the feature off when the last value is cleared', () => {
    expect(nextPopulationRange({ min: 4 }, 'min', '')).toBeUndefined();
    expect(nextPopulationRange({ max: 12 }, 'max', '  ')).toBeUndefined();
  });

  it('keeps the surviving half when only one is cleared', () => {
    expect(nextPopulationRange({ min: 4, max: 12 }, 'min', '')).toEqual({ max: 12 });
    expect(nextPopulationRange({ min: 4, max: 12 }, 'max', '')).toEqual({ min: 4 });
  });

  it('ignores junk instead of writing NaN into the config', () => {
    // NaN would serialize to null and reach the engine as a malformed range.
    expect(nextPopulationRange({ min: 4, max: 12 }, 'max', 'abc')).toEqual({ min: 4, max: 12 });
  });

  it('allows a contradictory pair to exist mid-edit', () => {
    // Typing "12" then "4" passes through max<min on the way to a valid range;
    // rejecting it would fight the user's keystrokes.
    expect(nextPopulationRange({ min: 12, max: 20 }, 'max', '4')).toEqual({ min: 12, max: 4 });
  });
});

describe('only a range the engine will act on counts as active', () => {
  it('accepts a well-formed range', () => {
    expect(isActiveRange({ min: 4, max: 12 })).toBe(true);
    expect(isActiveRange({ min: 6, max: 6 })).toBe(true);
  });

  it('rejects incomplete, inverted, and sub-2 ranges', () => {
    expect(isActiveRange(undefined)).toBe(false);
    expect(isActiveRange({ min: 4 })).toBe(false);
    expect(isActiveRange({ max: 12 })).toBe(false);
    expect(isActiveRange({ min: 12, max: 4 })).toBe(false);
    expect(isActiveRange({ min: 1, max: 12 })).toBe(false);
  });
});

describe('the hint says what will actually happen', () => {
  it('says off, and names the fixed size, when unset', () => {
    expect(adaptiveRangeHint(undefined, 8)).toMatch(/Off/);
    expect(adaptiveRangeHint(undefined, 8)).toContain('8');
  });

  it('warns that a half-filled range is ignored', () => {
    expect(adaptiveRangeHint({ min: 4 }, 8)).toMatch(/both/i);
    expect(adaptiveRangeHint({ max: 4 }, 8)).toMatch(/both/i);
  });

  it('explains an inverted range instead of pretending it works', () => {
    expect(adaptiveRangeHint({ min: 12, max: 4 }, 8)).toMatch(/at least the minimum/);
  });

  it('explains a floor below 2', () => {
    expect(adaptiveRangeHint({ min: 1, max: 8 }, 8)).toMatch(/at least 2/);
  });

  it('discloses that cost is quoted at the widest case', () => {
    const hint = adaptiveRangeHint({ min: 4, max: 12 }, 8);
    expect(hint).toContain('12');
    expect(hint).toContain('4');
    // The user is about to be quoted a bigger number than generationSize
    // implies; the hint must be where that is explained.
    expect(hint).toMatch(/[Cc]ost/);
  });
});
