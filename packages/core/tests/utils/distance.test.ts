import { describe, it, expect } from 'vitest';
import { levenshtein, levenshteinScore0to10, jsonDiffScore0to10, numericAbsScore0to10 } from '../../src/utils/distance.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('counts single character insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('counts single character deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('counts single character substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('handles completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'));
  });

  it('computes known distance for kitten/sitting', () => {
    // kitten -> sitten -> sittin -> sitting = 3
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('levenshteinScore0to10', () => {
  it('returns 10 for identical strings', () => {
    expect(levenshteinScore0to10('hello', 'hello')).toBe(10);
  });

  it('returns 0 for completely different strings of same length', () => {
    // Every character different
    expect(levenshteinScore0to10('aaa', 'zzz')).toBe(0);
  });

  it('returns score between 0 and 10', () => {
    const score = levenshteinScore0to10('kitten', 'sitting');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('higher similarity produces higher score', () => {
    const similar = levenshteinScore0to10('hello', 'hallo');
    const different = levenshteinScore0to10('hello', 'world');
    expect(similar).toBeGreaterThan(different);
  });

  it('handles empty vs non-empty (score 0)', () => {
    expect(levenshteinScore0to10('', 'abc')).toBe(0);
  });
});

describe('jsonDiffScore0to10', () => {
  it('returns 10 for identical JSON', () => {
    expect(jsonDiffScore0to10('{"a":1}', '{"a":1}')).toBe(10);
  });

  it('returns 10 for identical arrays', () => {
    expect(jsonDiffScore0to10('[1,2,3]', '[1,2,3]')).toBe(10);
  });

  it('returns less than 10 for partially different JSON', () => {
    const score = jsonDiffScore0to10('{"a":1,"b":2}', '{"a":1,"b":3}');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(10);
  });

  it('returns 0 for invalid JSON input', () => {
    expect(jsonDiffScore0to10('not json', '{"a":1}')).toBe(0);
  });

  it('returns 0 for both invalid JSON', () => {
    expect(jsonDiffScore0to10('not json', 'also not json')).toBe(0);
  });

  it('handles nested objects', () => {
    const a = '{"a":{"b":1,"c":2}}';
    const b = '{"a":{"b":1,"c":2}}';
    expect(jsonDiffScore0to10(a, b)).toBe(10);
  });

  it('detects missing keys', () => {
    const a = '{"a":1,"b":2}';
    const b = '{"a":1}';
    const score = jsonDiffScore0to10(a, b);
    expect(score).toBeLessThan(10);
  });

  it('score is between 0 and 10', () => {
    const score = jsonDiffScore0to10('{"x":1}', '{"y":2}');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });
});

describe('numericAbsScore0to10', () => {
  it('returns 10 for identical numbers', () => {
    expect(numericAbsScore0to10('5', '5')).toBe(10);
  });

  it('returns 10 for identical floats', () => {
    expect(numericAbsScore0to10('3.14', '3.14')).toBe(10);
  });

  it('returns high score for close numbers', () => {
    const score = numericAbsScore0to10('100', '101');
    expect(score).toBeGreaterThan(5);
  });

  it('returns low score for very different numbers', () => {
    const score = numericAbsScore0to10('1', '1000');
    expect(score).toBeLessThan(5);
  });

  it('returns 0 for non-numeric input', () => {
    expect(numericAbsScore0to10('abc', '123')).toBe(0);
  });

  it('returns 0 when gold is not a number', () => {
    expect(numericAbsScore0to10('not a number', '5')).toBe(0);
  });

  it('score is between 0 and 10', () => {
    const score = numericAbsScore0to10('10', '20');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('handles negative numbers', () => {
    const score = numericAbsScore0to10('-5', '-5');
    expect(score).toBe(10);
  });

  it('handles zero', () => {
    const score = numericAbsScore0to10('0', '0');
    expect(score).toBe(10);
  });
});

describe('levenshtein memory (bug-hunt regression)', () => {
  it('handles a huge output against a short reference without exhausting memory', () => {
    // The full (m+1)x(n+1) matrix took 777 MB for a 30-char reference against a
    // 3 MB output, and OOM-killed the process for a longer reference. Rolling
    // rows make it O(min(m,n)).
    const gold = 'the quick brown fox jumps over';
    const pred = 'x'.repeat(2_000_000);
    const before = process.memoryUsage().heapUsed;
    const start = Date.now();
    const score = levenshteinScore0to10(gold, pred);
    const grew = (process.memoryUsage().heapUsed - before) / 1e6;

    expect(score).toBe(0);                       // wildly different
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(grew).toBeLessThan(100);              // was ~500+ MB for this shape
  });

  it('still computes the same distances as before', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('a', 'b')).toBe(1);
    // Argument order must not matter
    expect(levenshtein('short', 'a much longer string')).toBe(levenshtein('a much longer string', 'short'));
  });
});
