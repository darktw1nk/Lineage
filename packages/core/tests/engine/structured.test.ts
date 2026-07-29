import { describe, it, expect } from 'vitest';
import { scoreJsonSchema, scoreToolCall } from '../../src/engine/structured.js';

const SCHEMA = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string' },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    age: { type: 'number' },
  },
} as object;

describe('scoreJsonSchema', () => {
  it('conformant JSON scores 10 and passes', () => {
    const r = scoreJsonSchema('{"name":"Bob","email":"b@x.co"}', SCHEMA);
    expect(r).toMatchObject({ score: 10, passed: true });
  });

  it('accepts fenced JSON', () => {
    const r = scoreJsonSchema('```json\n{"name":"Bob","email":"b@x.co"}\n```', SCHEMA);
    expect(r.score).toBe(10);
  });

  it('unparseable output scores 0', () => {
    const r = scoreJsonSchema('The contact is Bob (b@x.co)', SCHEMA);
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail).toMatch(/invalid JSON/);
  });

  it('violation count shapes the gradient', () => {
    const oneMissing = scoreJsonSchema('{"name":"Bob"}', SCHEMA);           // missing email
    const twoWrong = scoreJsonSchema('{"age":"old"}', SCHEMA);              // missing both + wrong type
    expect(oneMissing.score).toBeGreaterThan(twoWrong.score);
    expect(oneMissing.passed).toBe(false);
    expect(oneMissing.score).toBeLessThanOrEqual(5);
    expect(twoWrong.score).toBeGreaterThanOrEqual(1);
  });

  it('invalid schema scores 0 without throwing', () => {
    const r = scoreJsonSchema('{}', { type: 'not-a-type' } as object);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/schema error/);
  });

  it('missing schema scores 0 with a config message', () => {
    const r = scoreJsonSchema('{}', undefined);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/no schema/i);
  });

  it('re-validates when the schema changes under the same cache key (edited test)', () => {
    // Review-caught bug: caching by test id served the OLD compiled schema after
    // the user edited a test's schema in a long-lived process.
    const first = scoreJsonSchema('{"a":1}', { type: 'object', required: ['a'] } as object, 'stable-id');
    expect(first.score).toBe(10);
    const second = scoreJsonSchema('{"a":1}', { type: 'object', required: ['b'] } as object, 'stable-id');
    expect(second.score).toBeLessThan(10); // must validate against the NEW schema
    expect(second.detail).toMatch(/b/);
  });
});

const CALL = (name: string, args: Record<string, unknown>) => [{ name, arguments: args }];

describe('scoreToolCall', () => {
  it('no tool call scores 0', () => {
    const r = scoreToolCall(undefined, { name: 'get_weather' });
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail).toMatch(/no tool call/);
  });

  it('wrong tool scores 2', () => {
    const r = scoreToolCall(CALL('get_time', {}), { name: 'get_weather' });
    expect(r).toMatchObject({ score: 2, passed: false });
  });

  it('right tool, wrong args scores 6 with a diff in detail', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'London' }), { name: 'get_weather', args: { city: 'Paris' } });
    expect(r).toMatchObject({ score: 6, passed: false });
    expect(r.detail).toMatch(/Paris/);
    expect(r.detail).toMatch(/London/);
  });

  it('subset match with extra actual keys scores 10', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Paris', units: 'C' }), { name: 'get_weather', args: { city: 'Paris' } });
    expect(r).toMatchObject({ score: 10, passed: true });
  });

  it('exact mode rejects extra keys', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Paris', units: 'C' }),
      { name: 'get_weather', args: { city: 'Paris' }, argsMode: 'exact' });
    expect(r.score).toBe(6);
  });

  it('nested args deep-equal', () => {
    const r = scoreToolCall(CALL('book', { where: { city: 'Paris', floor: 2 } }),
      { name: 'book', args: { where: { city: 'Paris', floor: 2 } } });
    expect(r.score).toBe(10);
  });

  it('name-only expectation: any args score 10', () => {
    const r = scoreToolCall(CALL('get_weather', { city: 'Oslo' }), { name: 'get_weather' });
    expect(r.score).toBe(10);
  });

  it('first call is judged when multiple', () => {
    const r = scoreToolCall([...CALL('get_time', {}), ...CALL('get_weather', {})], { name: 'get_weather' });
    expect(r.score).toBe(2);
  });

  it('missing expectedTool is a config error scoring 0', () => {
    const r = scoreToolCall(CALL('get_weather', {}), undefined);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/expectedTool/);
  });
});
