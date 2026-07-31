import { describe, it, expect } from 'vitest';
import { balancedSpans, extractJsonArray } from '../../src/utils/text.js';

/**
 * Gap mutation testing found in utils/text.ts (hunt 13).
 *
 * structured.ts carries its own copy of the balanced-span scanner and has a
 * regression test for exactly this ("an unbalanced bracket earlier in the reply
 * does not hide the answer"). The SHARED scanner in utils/text.ts — the one
 * parseVerdict and extractJsonArray use — has no equivalent test, so changing
 * its recovery step back to `break` survives a fully green suite.
 *
 * That recovery is not cosmetic. In parseVerdict it decides whether an embedded
 * verdict is found at all: a judge that thinks out loud with a stray `{` before
 * its conclusion becomes 'unreadable', which then runs the ATTRIBUTION path and
 * can convict a candidate. In extractJsonArray it decides whether a
 * meta-prompting edit list is recovered or the whole operator call is wasted.
 */

describe('an unbalanced opener does not hide a later balanced span', () => {
  it('recovers the object that follows a stray brace', () => {
    const text = 'Let me think { about this. My verdict: {"winner":"B"}';
    expect(balancedSpans(text, '{', '}')).toEqual(['{"winner":"B"}']);
  });

  it('recovers the array that follows a stray bracket', () => {
    const text = 'See the list [ below for context. Edits: ["alpha","beta"]';
    expect(balancedSpans(text, '[', ']')).toEqual(['["alpha","beta"]']);
  });

  it('extractJsonArray survives prose containing an unclosed bracket', () => {
    // A real meta-prompting reply: the model narrates, leaves a bracket open in
    // the narration, then emits the edit list. `break` throws the list away and
    // the operator call is billed for nothing.
    const raw = 'Here are the edits [see the notes above\n\n[{"op":"replace","text":"x"}]';
    expect(extractJsonArray(raw)).toEqual([{ op: 'replace', text: 'x' }]);
  });

  it('still returns every top-level span when nothing is unbalanced', () => {
    expect(balancedSpans('{"a":1} and {"b":{"c":2}}', '{', '}'))
      .toEqual(['{"a":1}', '{"b":{"c":2}}']);
  });
});
