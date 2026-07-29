import { describe, it, expect } from 'vitest';
import { stripPromptDelimiters, extractJsonArray, fillTemplate } from '../../src/utils/text.js';

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
