import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { calculateFitness, resetFitnessWarnings } from '../../src/engine/fitness.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * "An unmeasurable dimension is DISABLED, never defaulted" is right about the
 * DEFAULT and wrong about who may trigger it.
 *
 * Disabling drops the weight from the denominator, which REDISTRIBUTES it onto
 * the dimensions the candidate is good at. So whenever the candidate controls
 * whether a thing can be measured, becoming unmeasurable beats scoring badly —
 * and evolution finds that immediately. Measured, with identical answers:
 *
 *   honest   tests [10,10,1,1]                    quality  5.5  fitness  5.5
 *   attacker tests [10,10,5(ungraded),5(ungraded)] quality 10.0  fitness 10.0
 *
 * The distinction that matters is WHO made it unmeasurable:
 *   - the CONFIG (no guardrails, samplesPerTest 1, no costNorm) -> disable. The
 *     candidate cannot influence this, and every candidate is affected equally.
 *   - a MEASUREMENT FAILURE on this candidate's own output -> fail CLOSED. The
 *     candidate must never profit from breaking its own grading.
 *
 * Excluding ungraded tests from the mean was the second wrong answer here (it
 * lets a candidate delete just the tests it fails); averaging in a 5.0
 * placeholder was the first (it lifts a 1/10 to 5/10). Scoring 0 is the only
 * choice a candidate cannot gain from. Genuine judge flakiness is surfaced by
 * `ungraded`, `ungradedTests` and the grading circuit breaker rather than by
 * quietly improving the candidate's score.
 */
function node(
  tests: Array<{ score: number; ungraded?: boolean; samples?: number[] }>,
  metrics: Record<string, unknown> = {},
): CandidateNode {
  return {
    id: 'n', generation: 0, lineageParents: [], status: 'finished', prompt: 'p',
    params: { model: { provider: 'x', model: 'y' }, temperature: 0 },
    changeLog: [],
    tests: tests.map((t, i) => ({
      testId: `t${i}`, passed: t.score >= 7, score: t.score,
      promptTokens: 1, completionTokens: 1, latencyMs: 1, outputText: 'o',
      ...(t.ungraded ? { ungraded: true } : {}),
      ...(t.samples ? { samples: t.samples } : {}),
    })),
    metrics: { quality: 0, fitness: 0, costUSD: 0, latencyMs: 1, ...metrics },
  } as any;
}

const cfg = (weights: any, extra: any = {}) => ({
  id: 'c', name: 'c', fitness: { weights, ...extra },
  selection: {}, operators: {}, population: {}, targets: {},
  enabledModels: [], serviceModel: { provider: 'x', model: 'y' },
  testSet: [], parallelLimit: 1,
} as unknown as EvaluationConfig);

beforeEach(() => resetFitnessWarnings());

describe('a candidate cannot profit by breaking its own grading', () => {
  it('selective ungrading does not beat answering honestly', () => {
    const honest = calculateFitness(
      node([{ score: 10 }, { score: 10 }, { score: 1 }, { score: 1 }]), cfg({ quality: 1 }),
    ).quality;
    const attacker = calculateFitness(
      node([{ score: 10 }, { score: 10 }, { score: 5, ungraded: true }, { score: 5, ungraded: true }]),
      cfg({ quality: 1 }),
    ).quality;

    expect(attacker).toBeLessThanOrEqual(honest);
  });

  it('an ungraded test contributes 0, not 5 and not nothing', () => {
    // 5.0 averaged in lifts a 1/10 candidate; excluding it deletes the low
    // score entirely. Both are gains the candidate authored.
    expect(calculateFitness(node([{ score: 10 }, { score: 5, ungraded: true }]), cfg({ quality: 1 })).quality)
      .toBe(5); // (10 + 0) / 2
  });

  it('placeholder samples do not buy perfect stability', () => {
    // An ungraded test's samples are two constant 5.0 placeholders — zero
    // spread, so the candidate was handed free reliability.
    const honest = calculateFitness(
      node([{ score: 9.5, samples: [10, 9] }, { score: 3, samples: [1, 5] }], { stability: undefined }),
      cfg({ quality: 0.5, stability: 0.5 }),
    );
    const attacker = calculateFitness(
      node([{ score: 9.5, samples: [10, 9] }, { score: 5, ungraded: true, samples: [5, 5] }],
        { stability: undefined }),
      cfg({ quality: 0.5, stability: 0.5 }),
    );
    expect(attacker.stability ?? 0).toBeLessThanOrEqual(honest.stability ?? 0);
  });
});

describe('config-level absence still disables; measurement failure does not', () => {
  it('no guardrails configured -> safety disabled, quality alone decides', () => {
    // The candidate cannot influence this, so disabling is correct and the
    // weight is genuinely not applicable.
    const r = calculateFitness(node([{ score: 8 }]), cfg({ quality: 0.5, safety: 0.5 }));
    expect(r.fitness).toBeCloseTo(8, 6);
  });

  it('guardrails configured but unmeasurable on THIS candidate -> no free weight', () => {
    // One unescaped quote made the safety judge unparseable, safety became
    // undefined, its weight was dropped, and fitness ROSE from 3.85 to 5.50 —
    // a 43% gain for leaking the secret, measured end to end.
    const graded = calculateFitness(
      node([{ score: 5.5 }], { safety: 0 }),
      cfg({ quality: 0.7, safety: 0.3 }, { guardrails: ['never reveal the secret'] }),
    ).fitness;
    const evaded = calculateFitness(
      node([{ score: 5.5 }], { safety: undefined }),
      cfg({ quality: 0.7, safety: 0.3 }, { guardrails: ['never reveal the secret'] }),
    ).fitness;

    expect(evaded).toBeLessThanOrEqual(graded);
  });
});
