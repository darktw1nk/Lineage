import { describe, it, expect } from 'vitest';
import { mulberry32, rngFor } from '../../src/engine/rng.js';

describe('rngFor', () => {
  it('same seed + labels => identical sequences', () => {
    const a = rngFor(42, 'operator-plan', 3);
    const b = rngFor(42, 'operator-plan', 3);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('different labels => different streams', () => {
    const a = rngFor(42, 'operator-plan', 3);
    const b = rngFor(42, 'parent-assign', 3);
    const c = rngFor(42, 'operator-plan', 4);
    expect(a()).not.toBe(b());
    expect(rngFor(42, 'operator-plan', 3)()).not.toBe(c());
  });

  it('different seeds => different streams', () => {
    expect(rngFor(1, 'x')()).not.toBe(rngFor(2, 'x')());
  });

  it('undefined seed => Math.random passthrough', () => {
    expect(rngFor(undefined, 'anything')).toBe(Math.random);
  });

  it('values are in [0, 1)', () => {
    const r = rngFor(7, 'range');
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('label types and boundaries are distinct', () => {
    expect(rngFor(42, '1', 2)()).not.toBe(rngFor(42, 1, 2)());   // string vs number label
    expect(rngFor(42, 'a', 'b')()).not.toBe(rngFor(42, 'ab')()); // boundary must matter
  });
});

describe('mulberry32 relocation', () => {
  it('produces the historical sequence for seed 42 (holdout splits must not shift)', () => {
    // Captured from the original holdout.ts implementation before the move.
    const r = mulberry32(42);
    expect(r()).toBeCloseTo(0.6011037519201636, 15);
    expect(r()).toBeCloseTo(0.44829055899754167, 15);
    expect(r()).toBeCloseTo(0.8524657934904099, 15);
  });
});
