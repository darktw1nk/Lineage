import { describe, it, expect } from 'vitest';
import { stripPromptDelimiters, extractJsonArray, fillTemplate, sanitizeForJudge, balancedSpans } from '../../src/utils/text.js';

describe('sanitizeForJudge', () => {
  // The judge prompt delimits sections with <<< >>>. A candidate that closes
  // its own block early gets everything after it read as prompt — and evolution
  // selects for that immediately, because it is free.
  it('leaves no literal delimiter for ANY run length', () => {
    for (const n of [3, 4, 5, 6, 7, 12]) {
      expect(sanitizeForJudge('>'.repeat(n))).not.toContain('>>>');
      expect(sanitizeForJudge('<'.repeat(n))).not.toContain('<<<');
    }
  });

  it('neutralises an opening delimiter in the shape the template uses', () => {
    // The template opens a block with `LABEL: <<<` at END of line, so that is
    // the only shape that can forge one. A `<<<` mid-line cannot, and leaving
    // it is what lets bash herestrings and heredocs through unmangled —
    // breaking those scored byte-perfect answers 2/10.
    expect(sanitizeForJudge('EXPECTED (reference): <<<')).not.toContain('<<<');
    const inline = 'use <<<EOF for a heredoc';
    expect(sanitizeForJudge(inline)).toBe(inline);
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeForJudge('a > b and c >> d')).toBe('a > b and c >> d');
  });
});

describe('balancedSpans', () => {
  it('matches a nested object, which a flat brace regex cannot', () => {
    const text = 'Verdict follows: {"winner":"A","scores":{"a":9,"b":4}} end.';
    expect(balancedSpans(text, '{', '}')).toEqual(['{"winner":"A","scores":{"a":9,"b":4}}']);
  });

  it('ignores braces inside string literals', () => {
    expect(balancedSpans('{"note":"a } brace"}', '{', '}')).toEqual(['{"note":"a } brace"}']);
  });

  it('returns spans in document order', () => {
    expect(balancedSpans('{"a":1} then {"b":2}', '{', '}')).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('fillTemplate', () => {
  // Every one of these was silently rewritten before any model saw it, because
  // a STRING replacement makes JS read $$, $&, $` and $' in the VALUE as
  // special replacement patterns.
  const cases: Array<[string, string]> = [
    ['Cheap = $, mid = $$, expensive = $$$', 'price tiers'],
    ['Math: $$E = mc^2$$', 'LaTeX'],
    ['In sed, $& refers to the whole match.', 'sed whole-match'],
    ["Bash: $` is not a thing, but $' is ANSI-C quoting.", 'shell quoting'],
  ];
  for (const [value, label] of cases) {
    it(`passes ${label} through untouched`, () => {
      expect(fillTemplate('BEFORE ${p} AFTER', { p: value })).toBe(`BEFORE ${value} AFTER`);
    });
  }

  it('does not re-scan a substituted value for the next placeholder', () => {
    // A parent prompt containing "${parentB}" used to get B's whole prompt
    // inlined; a model output containing "${expectedOutput}" used to get the
    // reference answer pasted into the answer being graded.
    const out = fillTemplate('A=${a} B=${b}', { a: 'contains ${b} literally', b: 'SECRET' });
    expect(out).toBe('A=contains ${b} literally B=SECRET');
  });

  it('leaves unknown placeholders verbatim', () => {
    expect(fillTemplate('${known} and ${unknown}', { known: 'x' })).toBe('x and ${unknown}');
  });
});

describe('stripPromptDelimiters', () => {
  it('strips a single <<< >>> wrapper with newlines', () => {
    expect(stripPromptDelimiters('<<<\nYou are a helpful bot.\n>>>')).toBe('You are a helpful bot.');
  });

  it('strips nested wrappers from compounding operator steps', () => {
    expect(stripPromptDelimiters('<<<\n<<<\nExtract severity.\n>>>\n>>>')).toBe('Extract severity.');
  });

  it('leaves a prompt written in <<<SECTION>>> style alone', () => {
    // The leading <<< and trailing >>> are not a matched pair here — they open
    // and close DIFFERENT blocks. The old both-ends-anchored lazy match ate
    // the first and last marker and left the middle ones dangling.
    const prompt = '<<<SYSTEM>>>\nYou are a careful assistant.\n<<<USER>>>\n{{input}}\n<<<END>>>';
    expect(stripPromptDelimiters(prompt)).toBe(prompt);
  });

  it('strips a single-line wrapper', () => {
    expect(stripPromptDelimiters('<<<Extract severity.>>>')).toBe('Extract severity.');
  });

  it('leaves unwrapped text unchanged (aside from trimming)', () => {
    expect(stripPromptDelimiters('  You extract information.  ')).toBe('You extract information.');
  });

  it('leaves text with only a leading delimiter unchanged', () => {
    expect(stripPromptDelimiters('<<< partial wrap without closer')).toBe('<<< partial wrap without closer');
  });

  it('keeps internal delimiters that are part of the content', () => {
    expect(stripPromptDelimiters('<<<\nUse <<<input>>> as a placeholder.\n>>>')).toBe('Use <<<input>>> as a placeholder.');
  });
});

describe('extractJsonArray', () => {
  it('parses a plain JSON array', () => {
    expect(extractJsonArray('[{"label":"META","edit":"x"}]')).toEqual([{ label: 'META', edit: 'x' }]);
  });

  it('parses a fenced JSON array', () => {
    expect(extractJsonArray('```json\n[{"label":"META","edit":"x"}]\n```')).toEqual([{ label: 'META', edit: 'x' }]);
  });

  it('extracts an array with prose before and after (flash-lite style)', () => {
    const raw = 'Here are the proposed edits:\n\n[{"label":"META","edit":"add an intent label followed by a colon"}]\n\nThese should improve the score.';
    expect(extractJsonArray(raw)).toEqual([{ label: 'META', edit: 'add an intent label followed by a colon' }]);
  });

  it('handles brackets inside edit strings', () => {
    expect(extractJsonArray('Sure! [{"edit":"[Structure] add a [PLAN] section"}] done')).toEqual([{ edit: '[Structure] add a [PLAN] section' }]);
  });

  it('throws when no array is present', () => {
    expect(() => extractJsonArray('I cannot produce edits for this prompt.')).toThrow(/No JSON array/);
  });
});

describe('extractJsonArray hostile inputs (bug-hunt regressions)', () => {
  it('does not corrupt an array whose strings mention code fences', () => {
    // Stripping ``` unconditionally rewrote the CONTENT — and prompt edits
    // about code fences are a common category here.
    const raw = '[{"label":"MUTATION","edit":"Require ```json ... ``` fences"}]';
    expect(extractJsonArray(raw)[0].edit).toBe('Require ```json ... ``` fences');
  });

  it('still unwraps a genuinely fenced array', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('recovers an array despite stray brackets in the prose', () => {
    // first-'[' to last-']' spanned the prose and failed to parse.
    expect(extractJsonArray('Here are the edits [see list below]:\n[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('[{"a":1}]\nNote: removed rule [3].')).toEqual([{ a: 1 }]);
  });

  it('ignores brackets inside strings', () => {
    expect(extractJsonArray('[{"edit":"use [brackets] freely"}]')[0].edit).toBe('use [brackets] freely');
  });

  it('still throws when there is no array at all', () => {
    expect(() => extractJsonArray('I could not produce edits.')).toThrow(/No JSON array/);
  });
});
