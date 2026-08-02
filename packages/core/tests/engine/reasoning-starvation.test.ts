import { describe, it, expect } from 'vitest';
import { emptyResponseReason } from '../../src/utils/text.js';

/**
 * A reasoning model can spend its entire token budget thinking and return NO
 * content. Measured on `gpt-5-nano` with `max_completion_tokens: 2048`:
 * `finish_reason: "length"`, `reasoning_tokens: 2048`, content length 0. At
 * 16000 the same request answered normally.
 *
 * The operators threw a bare "Empty response from meta-prompting". The run then
 * degraded to carried parents — in a measured run, 4 of 6 children per
 * generation were ERROR/CARRY and the champion never moved off the seed prompt
 * — while nothing anywhere said the cause was a token cap. The user sees a
 * flat run, not a misconfiguration.
 *
 * The adapter already knows: it sets `truncated` from `finish_reason`. This
 * turns that signal into an error a user can act on.
 */
describe('an empty reply that was cut off names the token cap', () => {
  it('blames the cap, and says which setting to raise', () => {
    const msg = emptyResponseReason({ output: '', truncated: true }, 2048);
    expect(msg).toMatch(/2048/);
    expect(msg).toMatch(/serviceModelMaxTokens/);
    // Reasoning models are the common cause and the least obvious one.
    expect(msg).toMatch(/reasoning/i);
  });

  it('does not blame the cap when the reply simply came back empty', () => {
    const msg = emptyResponseReason({ output: '', truncated: false }, 2048);
    expect(msg).not.toMatch(/serviceModelMaxTokens/);
    expect(msg).toMatch(/empty/i);
  });

  it('treats whitespace-only output as empty', () => {
    expect(emptyResponseReason({ output: '   \n ', truncated: true }, 512)).toMatch(/512/);
  });

  it('returns null when there is real output, so callers cannot misuse it', () => {
    expect(emptyResponseReason({ output: 'a real reply', truncated: false }, 2048)).toBeNull();
    // Truncated but non-empty is a different problem — the caller keeps the
    // partial text rather than throwing.
    expect(emptyResponseReason({ output: 'partial', truncated: true }, 2048)).toBeNull();
  });

  it('survives a missing cap without printing undefined at the user', () => {
    const msg = emptyResponseReason({ output: '', truncated: true }, undefined);
    expect(msg).toMatch(/serviceModelMaxTokens/);
    expect(msg).not.toMatch(/undefined/);
  });
});
