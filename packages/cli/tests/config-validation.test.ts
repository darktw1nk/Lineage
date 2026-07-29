import { describe, it, expect } from 'vitest';
import { validateCliConfig } from '../src/config.js';

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
