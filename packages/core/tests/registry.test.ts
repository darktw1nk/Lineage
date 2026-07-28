import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/store.js', () => ({
  store: { get: () => null, set: () => {}, store: {} },
  setStore: vi.fn(),
}));

import {
  registerOperator, registerProvider, getOperator, listOperators, listProviders,
  resetRegistry, BUILTIN_OPERATOR_NAMES,
} from '../src/registry.js';
import { getProviderAdapter } from '../src/providers/index.js';
import type { OperatorPlugin, ProviderAdapter } from '../src/types.js';

const fakeOp = (name: string): OperatorPlugin => ({
  name, parents: 1,
  apply: async ({ parent }) => ({
    prompt: parent.prompt + '!', changeLog: [{ label: 'FAKE', text: 'x' }],
    cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
  }),
});

const fakeAdapter = (name: string): ProviderAdapter => ({
  name: name as any,
  estimateTokens: () => ({ prompt: 1 }),
  call: async () => ({ output: 'ok', promptTokens: 1, completionTokens: 1, latencyMs: 1, usd: 0 }),
});

beforeEach(() => resetRegistry());

describe('operator registry', () => {
  it('pre-registers the five built-ins', () => {
    expect([...BUILTIN_OPERATOR_NAMES]).toEqual(['mutation', 'crossover', 'meta', 'param', 'model']);
    for (const n of BUILTIN_OPERATOR_NAMES) expect(getOperator(n)).toBeDefined();
    expect(getOperator('crossover')!.parents).toBe(2);
  });

  it('registers and lists plugin operators', () => {
    registerOperator(fakeOp('section-shuffle'));
    expect(getOperator('section-shuffle')!.name).toBe('section-shuffle');
    expect(listOperators().map(o => o.name)).toContain('section-shuffle');
  });

  it('throws on duplicate operator names, including built-ins', () => {
    registerOperator(fakeOp('dup'));
    expect(() => registerOperator(fakeOp('dup'))).toThrow(/already registered/);
    expect(() => registerOperator(fakeOp('mutation'))).toThrow(/already registered/);
  });

  it('resetRegistry clears plugins but keeps built-ins', () => {
    registerOperator(fakeOp('temp-op'));
    resetRegistry();
    expect(getOperator('temp-op')).toBeUndefined();
    expect(getOperator('mutation')).toBeDefined();
  });
});

describe('provider registry', () => {
  it('getProviderAdapter falls back to registered plugin providers', () => {
    registerProvider({ adapter: fakeAdapter('ollama') });
    expect(getProviderAdapter('ollama').name).toBe('ollama');
    expect(listProviders()).toContain('ollama');
  });

  it('built-ins win and cannot be shadowed', () => {
    expect(() => registerProvider({ adapter: fakeAdapter('openai') })).toThrow(/already registered/);
    expect(getProviderAdapter('openai').name).toBe('openai');
  });

  it('throws a clear error for unknown providers', () => {
    expect(() => getProviderAdapter('nope')).toThrow(/Unknown provider: nope/);
  });
});
