import { describe, it, expect } from 'vitest';
import { cn } from '../../../src/utils/cn';

describe('cn', () => {
  it('merges simple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes via clsx', () => {
    expect(cn('foo', false && 'bar', 'baz')).toBe('foo baz');
  });

  it('resolves tailwind conflicts (last wins)', () => {
    // tailwind-merge should resolve p-4 vs p-2 → p-2
    const result = cn('p-4', 'p-2');
    expect(result).toBe('p-2');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });

  it('handles undefined and null values', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });

  it('merges conflicting tailwind colors', () => {
    const result = cn('text-red-500', 'text-blue-500');
    expect(result).toBe('text-blue-500');
  });

  it('preserves non-conflicting classes', () => {
    const result = cn('p-4', 'mt-2', 'text-sm');
    expect(result).toContain('p-4');
    expect(result).toContain('mt-2');
    expect(result).toContain('text-sm');
  });
});
