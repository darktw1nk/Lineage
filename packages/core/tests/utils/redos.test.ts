import { describe, it, expect } from 'vitest';
import { stripPromptDelimiters } from '../../src/utils/text.js';

describe('stripPromptDelimiters is linear, not catastrophic (bug-hunt regression)', () => {
  it('handles a wrapped answer with a trailing sentence in milliseconds', () => {
    // The old `/^<<<\s*([\s\S]*)\s*>>>$/` had three adjacent quantifiers, so
    // every FAILING match enumerated their cross-product. The failing case is
    // routine — a model wraps its answer then adds "Hope this helps!" — and it
    // measured 90 SECONDS for 12KB, synchronously on the only thread: no IPC,
    // no Stop button, no Ctrl-C.
    const build = (pad: number) => '<<<' + '\n'.repeat(pad) + 'PROMPT BODY' + '\n'.repeat(pad) + '>>>\nHope this helps!';
    const start = Date.now();
    for (const pad of [200, 800, 3200, 12800, 51200]) {
      stripPromptDelimiters(build(pad));
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // was minutes-to-hours at the top size
  });

  it('still unwraps, nests, and leaves sibling blocks alone', () => {
    expect(stripPromptDelimiters('<<<\nHello\n>>>')).toBe('Hello');
    expect(stripPromptDelimiters('<<<\n<<<\nNested\n>>>\n>>>')).toBe('Nested');
    const siblings = '<<<SYSTEM>>>\nA\n<<<END>>>';
    expect(stripPromptDelimiters(siblings)).toBe(siblings);
    expect(stripPromptDelimiters('<<<\nBody\n>>>\nTrailing.')).toBe('<<<\nBody\n>>>\nTrailing.');
  });
});
