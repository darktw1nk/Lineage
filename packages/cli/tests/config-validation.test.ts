import { describe, it, expect, vi } from 'vitest';
import { validateCliConfig, toEvaluationConfig } from '../src/config.js';

const base = { seedPrompt: 'x', testSet: [{ prompt: 'p', mode: 'llm_grade' }] } as any;
const rejects = (label: string, cfg: any) =>
  it(`rejects ${label}`, () => expect(() => validateCliConfig(cfg)).toThrow());

describe('config validation rejects configs that would burn a budget for nothing', () => {
  // Each of these previously ran to completion at full cost with exit 0.
  rejects('maxGenerations: 0 (ran UNBOUNDED)', { ...base, maxGenerations: 0 });
  rejects('maxGenerations: "two" (ran UNBOUNDED)', { ...base, maxGenerations: 'two' });
  rejects('populationSize: 0', { ...base, populationSize: 0 });
  rejects('populationSize: -3', { ...base, populationSize: -3 });
  rejects('models: [] (became serviceModel undefined)', { ...base, models: [] });
  rejects('duplicate test ids (report fabricated an improvement)', {
    ...base, testSet: [{ id: 'same', prompt: 'a' }, { id: 'same', prompt: 'b' }],
  });
  rejects('exact_match with no expected (every candidate scores 0)', {
    ...base, testSet: [{ prompt: 'a', mode: 'exact_match' }],
  });
  rejects('holdoutShare: 1.5', { ...base, holdoutShare: 1.5 });
  rejects('holdoutShare: -0.5', { ...base, holdoutShare: -0.5 });
  rejects('seed: "abc"', { ...base, seed: 'abc' });

  it('still accepts a valid config', () => {
    expect(() => validateCliConfig(base)).not.toThrow();
  });

  it('warns about a nested typo instead of silently using the default', () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { written.push(s); return true; };
    try {
      validateCliConfig({ ...base, operators: { mutationshare: 0.9 }, selection: { topk: 1 } } as any);
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(written.join('')).toMatch(/operators\.mutationshare/);
    expect(written.join('')).toMatch(/selection\.topk/);
  });
});

describe('selection.diversity survives the CLI config boundary', () => {
  it('passes a valid value through to the engine config', () => {
    const cfg = toEvaluationConfig({ ...base, selection: { policy: 'topk', topK: 3, diversity: 0.4 } });
    expect(cfg.selection.diversity).toBe(0.4);
  });

  it('defaults to 0 when omitted, so existing configs are unchanged', () => {
    const cfg = toEvaluationConfig({ ...base });
    expect(cfg.selection.diversity).toBe(0);
  });

  it('rejects an out-of-range value rather than passing nonsense to the engine', () => {
    expect(() => validateCliConfig({ ...base, selection: { diversity: 1.5 } })).toThrow(/selection\.diversity/);
    expect(() => validateCliConfig({ ...base, selection: { diversity: -1 } })).toThrow(/selection\.diversity/);
  });

  it('does not warn about diversity as an unknown selection field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateCliConfig({ ...base, selection: { diversity: 0.5 } });
    const unknownWarnings = warn.mock.calls.map(c => c.join(' ')).filter(m => /unknown/i.test(m) && /diversity/i.test(m));
    expect(unknownWarnings).toEqual([]);
    warn.mockRestore();
  });
});

describe('operators.adaptivity survives the CLI config boundary', () => {
  it('passes a valid value through to the engine config', () => {
    const cfg = toEvaluationConfig({ ...base, operators: { adaptivity: 0.6 } });
    expect((cfg.operators as any).adaptivity).toBe(0.6);
  });

  it('defaults to 0 so existing configs breed exactly as before', () => {
    expect((toEvaluationConfig({ ...base }).operators as any).adaptivity).toBe(0);
  });

  it('rejects an out-of-range value', () => {
    expect(() => validateCliConfig({ ...base, operators: { adaptivity: 2 } })).toThrow(/operators\.adaptivity/);
    expect(() => validateCliConfig({ ...base, operators: { adaptivity: -0.5 } })).toThrow(/operators\.adaptivity/);
  });

  it('does not warn about adaptivity as an unknown operator field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateCliConfig({ ...base, operators: { adaptivity: 0.5 } });
    const unknown = warn.mock.calls.map(c => c.join(' ')).filter(m => /unknown/i.test(m) && /adaptivity/i.test(m));
    expect(unknown).toEqual([]);
    warn.mockRestore();
  });
});
