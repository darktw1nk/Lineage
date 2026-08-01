import { describe, it, expect } from 'vitest';
import { paretoFront } from '../../src/engine/pareto.js';

/**
 * Pareto reporting.
 *
 * Fitness is a WEIGHTED SUM of five dimensions, and a weighted sum provably
 * cannot select points in a concave region of the trade-off surface: however
 * you tune the weights, some genuinely good candidates can never win. That is
 * a real limitation of the selection model and changing it would be a
 * different product ("here are twelve incomparable prompts, you pick").
 *
 * This is the cheap, honest half: after a run, say which candidates were
 * NON-DOMINATED — nothing else in the run was at least as good on every
 * dimension and strictly better on one. If the champion is the only one, the
 * scalarization lost you nothing. If there are others, the user can see
 * exactly what the weights traded away.
 *
 * Direction matters: quality/safety/stability are better HIGH, cost/latency
 * are better LOW. Getting that backwards would report the worst candidates as
 * the interesting ones.
 */
const cand = (id: string, m: Partial<Record<string, number>>) => ({ id, metrics: m } as any);

describe('domination respects each dimension direction', () => {
  it('higher quality dominates when nothing else differs', () => {
    const front = paretoFront([
      cand('better', { quality: 9, costUSD: 0.01 }),
      cand('worse', { quality: 5, costUSD: 0.01 }),
    ]);
    expect(front.map(n => n.id)).toEqual(['better']);
  });

  it('LOWER cost dominates, not higher', () => {
    const front = paretoFront([
      cand('cheap', { quality: 9, costUSD: 0.001 }),
      cand('pricey', { quality: 9, costUSD: 0.100 }),
    ]);
    expect(front.map(n => n.id)).toEqual(['cheap']);
  });

  it('LOWER latency dominates, not higher', () => {
    const front = paretoFront([
      cand('fast', { quality: 7, latencyMs: 200 }),
      cand('slow', { quality: 7, latencyMs: 5000 }),
    ]);
    expect(front.map(n => n.id)).toEqual(['fast']);
  });

  it('treats safety and stability as better-high', () => {
    const front = paretoFront([
      cand('safe', { quality: 6, safety: 10, stability: 9 }),
      cand('risky', { quality: 6, safety: 3, stability: 2 }),
    ]);
    expect(front.map(n => n.id)).toEqual(['safe']);
  });
});

describe('the front keeps genuine trade-offs', () => {
  it('keeps both when one is better on quality and the other on cost', () => {
    const front = paretoFront([
      cand('accurate', { quality: 9, costUSD: 0.10 }),
      cand('cheap', { quality: 6, costUSD: 0.001 }),
    ]);
    expect(front.map(n => n.id).sort()).toEqual(['accurate', 'cheap']);
  });

  it('drops a candidate that is worse on every dimension', () => {
    const front = paretoFront([
      cand('a', { quality: 9, costUSD: 0.01, latencyMs: 100 }),
      cand('b', { quality: 6, costUSD: 0.05, latencyMs: 900 }),
      cand('c', { quality: 8, costUSD: 0.20, latencyMs: 80 }),
    ]);
    expect(front.map(n => n.id)).not.toContain('b');
    expect(front.map(n => n.id).sort()).toEqual(['a', 'c']);
  });

  it('an exact duplicate does not dominate its twin — both or neither', () => {
    const front = paretoFront([
      cand('x', { quality: 7, costUSD: 0.01 }),
      cand('y', { quality: 7, costUSD: 0.01 }),
    ]);
    expect(front).toHaveLength(2);
  });
});

describe('it never lies about candidates it cannot compare', () => {
  it('ignores dimensions missing from a candidate rather than treating them as 0', () => {
    // A candidate with no latency measurement must not be reported as
    // infinitely fast. Cost is the only shared dimension here, so 'cheap' wins
    // on it and neither dominates on latency.
    const front = paretoFront([
      cand('cheap', { quality: 7, costUSD: 0.001 }),
      cand('nolatency', { quality: 7, costUSD: 0.010 }),
    ]);
    expect(front.map(n => n.id)).toEqual(['cheap']);
  });

  it('returns an empty front for an empty population', () => {
    expect(paretoFront([])).toEqual([]);
  });

  it('skips candidates with no metrics at all', () => {
    const front = paretoFront([cand('scored', { quality: 5 }), { id: 'unscored' } as any]);
    expect(front.map(n => n.id)).toEqual(['scored']);
  });

  it('a single scored candidate is trivially the whole front', () => {
    expect(paretoFront([cand('only', { quality: 4, costUSD: 0.5 })]).map(n => n.id)).toEqual(['only']);
  });
});
