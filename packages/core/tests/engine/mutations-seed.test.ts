import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import { varyParameters } from '../../src/engine/paramvariation.js';
import { varyModel } from '../../src/engine/modelvariation.js';
import { rngFor } from '../../src/engine/rng.js';

const cfg = {
  operators: {
    paramVariation: { enabled: true, temperature: { enabled: true, min: 0.2, max: 1.0 } },
    modelVariation: { enabled: true },
  },
} as any;

describe('seeded operator randomness', () => {
  it('varyParameters is deterministic under a seeded rng', () => {
    const a = varyParameters(0.7, cfg, true, rngFor(42, 't'));
    const b = varyParameters(0.7, cfg, true, rngFor(42, 't'));
    expect(a.temperature).toBe(b.temperature);
    expect(a.temperature).toBeGreaterThanOrEqual(0.2);
    expect(a.temperature).toBeLessThanOrEqual(1.0);
    const c = varyParameters(0.7, cfg, true, rngFor(43, 't'));
    expect(c.temperature).not.toBe(a.temperature);
  });

  it('varyModel picks deterministically under a seeded rng', () => {
    const models = [
      { provider: 'a', model: '1' }, { provider: 'b', model: '2' },
      { provider: 'c', model: '3' }, { provider: 'd', model: '4' },
    ];
    const pick = (seed: number) =>
      varyModel(models[0], cfg, true, models, rngFor(seed, 'm')).model;
    expect(pick(42)).toEqual(pick(42));
  });
});

describe('mutation strategy selection', () => {
  it('is deterministic under a seeded rng (observable via the proposal prompt)', async () => {
    const { registerProvider, resetRegistry } = await import('../../src/registry.js');
    const prompts: string[] = [];
    const register = () => {
      resetRegistry();
      registerProvider({ adapter: { name: 'cap', estimateTokens: () => ({ prompt: 1 }),
        call: async (opts: any) => {
          prompts.push(opts.prompt);
          if (opts.prompt.includes('mutations to improve')) return { output: '[{"label":"MUTATION","edit":"x"}]', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
          return { output: 'NEW PROMPT', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 };
        } } as any });
    };
    const mcfg = {
      serviceModel: { provider: 'cap', model: 'm' }, serviceModelMaxTokens: 100, retries: 1,
      operators: {},
    } as any;

    register();
    const { mutateNode } = await import('../../src/engine/mutations.js');
    await mutateNode('BASE', mcfg, rngFor(42, 'fill', 1));
    const first = prompts.find(p => p.includes('mutations to improve'));

    prompts.length = 0;
    register();
    await mutateNode('BASE', mcfg, rngFor(42, 'fill', 1));
    const second = prompts.find(p => p.includes('mutations to improve'));

    expect(first).toBe(second); // same strategies, same count, same order
  });
});
