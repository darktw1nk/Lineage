import { describe, it, expect } from 'vitest';
import { listProviders, registerProvider, resetRegistry } from '@lineage/core';

/**
 * The guard added to handleResumeRun asks listProviders() whether every
 * provider a checkpointed config references is actually registered.
 *
 * Without it, resuming a run that used a PLUGIN provider without re-supplying
 * --config produced no error: every remaining node failed with "Unknown
 * provider", the run was still marked finished, the CLI exited 0, and the run
 * could never be resumed again. This pins the premise the guard relies on.
 */
describe('plugin providers are invisible until their plugin loads', () => {
  it('a plugin provider is absent from listProviders() before registration', () => {
    resetRegistry();
    expect(listProviders()).not.toContain('fake');
  });

  it('and present after it', () => {
    resetRegistry();
    registerProvider({
      adapter: { name: 'fake', estimateTokens: () => ({ prompt: 1 }), call: async () => ({}) } as any,
    });
    expect(listProviders()).toContain('fake');
    resetRegistry();
  });

  it('the built-ins are always available, so a normal resume is unaffected', () => {
    resetRegistry();
    const available = listProviders();
    for (const p of ['openai', 'anthropic', 'gemini', 'openrouter', 'groq']) {
      expect(available).toContain(p);
    }
  });
});
