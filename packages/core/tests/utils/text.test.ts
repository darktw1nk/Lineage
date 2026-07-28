import { describe, it, expect } from 'vitest';
import { stripPromptDelimiters, extractJsonArray } from '../../src/utils/text.js';

describe('stripPromptDelimiters', () => {
  it('strips a single <<< >>> wrapper with newlines', () => {
    expect(stripPromptDelimiters('<<<\nYou are a helpful bot.\n>>>')).toBe('You are a helpful bot.');
  });

  it('strips nested wrappers from compounding operator steps', () => {
    expect(stripPromptDelimiters('<<<\n<<<\nExtract severity.\n>>>\n>>>')).toBe('Extract severity.');
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
