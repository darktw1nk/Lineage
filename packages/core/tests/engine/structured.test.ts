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

  it('the gradient rewards being CLOSER, not failing earlier (bug-hunt regression)', () => {
    // Scoring by raw ajv error count inverted this: a nearly-complete object
    // trips one error per missing field, while a bare scalar trips exactly one
    // root-type error — so garbage outranked near-misses.
    const FIVE = {
      type: 'object', additionalProperties: false, required: ['a', 'b', 'c', 'd', 'e'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' }, e: { type: 'string' } },
    } as object;
    const s = (out: string) => scoreJsonSchema(out, FIVE).score;

    const perfect = s('{"a":"1","b":"2","c":"3","d":"4","e":"5"}');
    const fourOfFive = s('{"a":"1","b":"2","c":"3","d":"4"}');
    const oneOfFive = s('{"a":"1"}');
    const emptyObject = s('{}');
    const unrelatedArray = s('[]');
    const bareString = s('"hello"');

    expect(perfect).toBe(10);
    expect(fourOfFive).toBeGreaterThan(oneOfFive);
    expect(oneOfFive).toBeGreaterThan(emptyObject);
    // The inversion: wrong-shaped output must NOT beat a partially-correct object
    expect(unrelatedArray).toBeLessThan(oneOfFive);
    expect(bareString).toBeLessThan(oneOfFive);
    // All partial credit stays below the pass threshold
    expect(fourOfFive).toBeLessThanOrEqual(5);
  });

  it('extracts JSON embedded in prose, but scores it below a clean emit', () => {
    // Prose-wrapped JSON is recoverable, so it beats a 0 — but it is a format
    // failure (JSON.parse on the raw response throws), so it must not pass and
    // must never tie a clean emit.
    const r = scoreJsonSchema('Sure! Here you go: {"name":"Bob","email":"b@x.co"} — hope that helps.', SCHEMA);
    expect(r.score).toBe(5);
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(scoreJsonSchema('{"name":"Bob","email":"b@x.co"}', SCHEMA).score);
  });

  it('a schema template echoed in prose cannot outscore a real answer (bug-hunt regression)', () => {
    // The extractor made this a 0 -> 10 jump: a model that REFUSED the task but
    // quoted the format validated and scored a perfect 10, handing evolution a
    // gradient that rewards echoing the template.
    const echo = scoreJsonSchema(
      'Sure! I\'ll answer using the format {"answer": "<your answer here>"}.\n\nHmm, actually I\'m not able to determine the answer.',
      { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } as object,
    );
    const real = scoreJsonSchema('{"answer":"42"}', { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } as object);
    expect(echo.passed).toBe(false);
    expect(echo.score).toBeLessThan(real.score);
  });

  it('scores the last JSON span, not a leading placeholder example', () => {
    const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string', pattern: '^[0-9]+$' } } } as object;
    const r = scoreJsonSchema('Example: {"answer":"PLACEHOLDER"}\nReal answer: {"answer":"42"}', schema);
    // The real answer satisfies the pattern; the placeholder does not.
    expect(r.detail).not.toMatch(/pattern/);
  });

  it('present-but-invalid required keys earn no credit even behind a $ref', () => {
    // Compiling each property sub-schema standalone threw on an unresolvable
    // $ref, and the catch awarded full credit — so wrong values scored the
    // partial-credit ceiling.
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      definitions: { Str: { type: 'string' } },
      properties: { a: { $ref: '#/definitions/Str' }, b: { $ref: '#/definitions/Str' } },
    } as object;
    const bothWrong = scoreJsonSchema('{"a":1,"b":2}', schema);
    const bothRight = scoreJsonSchema('{"a":"x","b":"y"}', schema);
    expect(bothRight.score).toBe(10);
    expect(bothWrong.score).toBeLessThanOrEqual(2);
  });

  it('an array FIELD inside the answer does not outrank the answer (bug-hunt regression)', () => {
    // Spans were collected in two passes ({...} then [...]) and then reversed,
    // so every array span outranked every object span — including an array
    // nested INSIDE the answer. A prose-wrapped conforming object with any
    // array field scored 1, the same as complete garbage.
    const schema = {
      type: 'object', required: ['name', 'tags'],
      properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    } as object;
    const r = scoreJsonSchema('Sure! Here you go: {"name":"Ada","tags":["math","logic"]}', schema);
    expect(r.score).toBe(5); // conforming-but-in-prose, not 1
  });

  it('an unbalanced bracket earlier in the reply does not hide the answer (bug-hunt regression)', () => {
    // Merging both bracket types into one left-to-right pass made ONE
    // unterminated opener abort all extraction, so a code snippet before the
    // answer took the score from 5 to 0.
    const schema = { type: 'array', items: { type: 'string' } } as object;
    const r = scoreJsonSchema('Use a guard: if (x) { return;\n\nMy answer: ["alpha","beta"]', schema);
    expect(r.score).toBe(5); // recovered from prose, not 0

    const objSchema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } as object;
    const r2 = scoreJsonSchema('Consider the list [1, 2, 3 (oops).\nAnswer: {"answer":"hi"}', objSchema);
    expect(r2.score).toBe(5);
  });

  it('stays fast on pathological bracket soup', () => {
    const schema = { type: 'object', required: ['a'] } as object;
    const start = Date.now();
    scoreJsonSchema('{'.repeat(200_000), schema);
    scoreJsonSchema('{}'.repeat(100_000), schema);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('picks the span that validates, not the first or last one', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } as object;
    // Trailing schema-reference blob: preferring the LAST span scored this 1.
    const trailing = scoreJsonSchema('Answer: {"name":"Ada"}\nFor reference the schema was {"type":"object"}', schema);
    // Leading placeholder example: preferring the FIRST span scored this 1.
    const leading = scoreJsonSchema('Example: {"foo":1}\nReal answer: {"name":"Ada"}', schema);
    expect(trailing.score).toBe(5);
    expect(leading.score).toBe(5);
  });

  it('one extra field is a near-miss, not indistinguishable from garbage (bug-hunt regression)', () => {
    // penalty = otherErrors / required.length saturated at ONE error when a
    // single key was required, so the commonest near-miss a model produces —
    // the right answer plus a "reasoning" key — scored the same as {}.
    const schema = {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { type: 'string' } },
    } as object;
    const s = (out: string) => scoreJsonSchema(out, schema).score;

    expect(s('{"answer":"hi"}')).toBe(10);
    const nearMiss = s('{"answer":"hi","reasoning":"because"}');
    expect(nearMiss).toBeGreaterThan(s('{}'));
    expect(nearMiss).toBeGreaterThan(s('"hi"'));
    expect(nearMiss).toBeLessThanOrEqual(5);
  });

  it('extra violations outrank nothing: more broken never scores higher (bug-hunt regression)', () => {
    // satisfiedFraction measured only required-key presence, so an object with
    // every key present plus four additionalProperties violations hit the 5
    // ceiling while a strictly closer object missing one key scored 3.
    const schema = {
      type: 'object', additionalProperties: false, required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    } as object;
    const missingOne = scoreJsonSchema('{"a":"x"}', schema);
    const allPresentButFourExtras = scoreJsonSchema('{"a":"x","b":"y","z1":1,"z2":2,"z3":3,"z4":4}', schema);
    expect(missingOne.score).toBeGreaterThan(allPresentButFourExtras.score);
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
