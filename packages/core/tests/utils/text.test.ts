import { describe, it, expect } from 'vitest';
import { stripPromptDelimiters } from '../../src/utils/text.js';

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
