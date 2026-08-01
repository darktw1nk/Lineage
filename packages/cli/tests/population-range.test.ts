import { describe, it, expect } from 'vitest';
import { toEvaluationConfig, validateCliConfig } from '../src/config.js';

/**
 * `populationRange` at the CLI boundary.
 *
 * The engine trusts its input, so an unvalidated range reaches
 * `adaptiveGenerationSize` and silently disables itself (`max < min` returns
 * the configured size) — the user asked for adaptive sizing, got fixed sizing,
 * and was never told. Reject it here instead, where the message can name the
 * field.
 */
const base = {
  name: 'range',
  seedPrompt: 'Summarize the ticket.',
  models: ['openai/gpt-4o-mini'],
  serviceModel: 'openai/gpt-4o-mini',
  testSet: [{ name: 't', mode: 'llm_grade' as const, prompt: 'in', expected: 'out' }],
};

/** The real CLI path: validate first, then map. A test that skipped the
 *  validation step would report every malformed range as accepted. */
const build = (over: any) => {
  const cfg = { ...base, ...over } as any;
  validateCliConfig(cfg);
  return toEvaluationConfig(cfg);
};

describe('populationRange reaches the engine', () => {
  it('is absent by default, so sizing stays fixed', () => {
    expect(build({}).population.populationRange).toBeUndefined();
  });

  it('is passed through on the auto-fill path', () => {
    const cfg = build({ populationRange: { min: 4, max: 12 } });
    expect(cfg.population.fill).toBe('auto');
    expect(cfg.population.populationRange).toEqual({ min: 4, max: 12 });
  });

  it('is passed through on the manual-fill path too', () => {
    const cfg = build({ initialPrompts: ['a', 'b'], populationRange: { min: 4, max: 12 } });
    expect(cfg.population.fill).toBe('manual');
    expect(cfg.population.populationRange).toEqual({ min: 4, max: 12 });
  });
});

describe('a range that cannot work is rejected, not ignored', () => {
  it('rejects max below min', () => {
    expect(() => build({ populationRange: { min: 10, max: 4 } })).toThrow(/populationRange\.max/);
  });

  it('rejects a missing half', () => {
    expect(() => build({ populationRange: { min: 4 } })).toThrow(/populationRange/);
    expect(() => build({ populationRange: { max: 4 } })).toThrow(/populationRange/);
  });

  it('rejects a floor below 2, which cannot breed', () => {
    expect(() => build({ populationRange: { min: 1, max: 8 } })).toThrow(/populationRange\.min/);
  });

  it('rejects non-integer and non-numeric bounds', () => {
    expect(() => build({ populationRange: { min: 2.5, max: 8 } })).toThrow(/populationRange\.min/);
    expect(() => build({ populationRange: { min: 2, max: 'eight' } })).toThrow(/populationRange\.max/);
  });

  it('rejects a range that is not an object', () => {
    expect(() => build({ populationRange: 8 })).toThrow(/populationRange/);
    expect(() => build({ populationRange: [4, 8] })).toThrow(/populationRange/);
  });

  it('accepts min === max, which just pins the size', () => {
    expect(build({ populationRange: { min: 6, max: 6 } }).population.populationRange)
      .toEqual({ min: 6, max: 6 });
  });
});

describe('the key is known to the config parser', () => {
  it('does not warn about populationRange as an unknown key', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { build({ populationRange: { min: 4, max: 10 } }); } finally { console.warn = orig; }
    expect(warnings.join('\n')).not.toMatch(/populationRange/);
  });
});
