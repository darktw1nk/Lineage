import { describe, it, expect } from 'vitest';
import { carryShare, carryShareWarns } from '../../src/utils/carryShare';

/** Pass-20 deferred debt: the all-carry dead run was invisible in the desktop. */
const node = (label: string | null) => ({
  id: 'n', changeLog: label ? [{ label, text: 'x' }] : [],
} as any);

describe('carryShare', () => {
  it('counts CARRY and ERROR children, excluding the seed baseline', () => {
    const gens = [
      [node('MUTATION'), node('CARRY'), node('ERROR')],   // seed + 2 carried
      [node('ELITE'), node('CARRY'), node('MUTATION')],   // 1 carried of 3
    ];
    expect(carryShare(gens as any)).toEqual({ carried: 3, children: 5 });
  });

  it('warns at half or more, stays quiet below', () => {
    expect(carryShareWarns({ carried: 3, children: 5 })).toBe(true);
    expect(carryShareWarns({ carried: 2, children: 5 })).toBe(false);
    expect(carryShareWarns({ carried: 0, children: 0 })).toBe(false);
  });

  it('survives missing generations and empty changelogs', () => {
    expect(carryShare(undefined)).toEqual({ carried: 0, children: 0 });
    expect(carryShare([[node(null), node(null)]] as any)).toEqual({ carried: 0, children: 1 });
  });
});
