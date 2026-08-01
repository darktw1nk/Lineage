import { describe, it, expect } from 'vitest';
import { crossoverModeHint } from '../src/utils/crossoverMode';

/**
 * The hint has to carry the cost consequence, because that is what decides the
 * choice: the LLM merge bills a service call per crossover child and splicing
 * bills none. A hint that only restated the mode name would leave the user
 * picking blind.
 */
describe('each crossover mode discloses what it costs', () => {
  it('says splicing is free', () => {
    expect(crossoverModeHint('structural')).toMatch(/free|no LLM calls/i);
  });

  it('says the LLM merge is billed per child', () => {
    expect(crossoverModeHint('llm')).toMatch(/billed|call per/i);
  });

  it('says auto pays only on the fallback', () => {
    const hint = crossoverModeHint('auto');
    expect(hint).toMatch(/free/i);
    expect(hint).toMatch(/only when/i);
  });

  it('gives every mode a distinct explanation', () => {
    const hints = (['auto', 'structural', 'llm'] as const).map(crossoverModeHint);
    expect(new Set(hints).size).toBe(3);
    expect(hints.every(h => h.length > 40)).toBe(true);
  });
});
