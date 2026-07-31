import { describe, it, expect } from 'vitest';
import { scoreJsonSchema, scoreToolCall } from '../../src/engine/structured.js';

/**
 * Gaps mutation testing found in structured.ts (hunt 13).
 *
 * Every existing tool_call test declares exactly ONE expected argument and
 * passes `undefined` (never `[]`, never `{}`) for the degenerate inputs; every
 * existing schema declares a `required` list and plain ASCII key names; and no
 * test ever nests the answer inside another object. Eight semantic mutations
 * survived a fully green suite.
 */

describe('subset arg matching requires EVERY expected arg, not just one', () => {
  // `Object.entries(expected.args).every(...)` -> `.some(...)` survived: every
  // existing args assertion uses a single-key expectation, where the two are
  // identical. With two or more expected args the mutant passes a call that got
  // one of them right — the commonest partial failure a tool-calling model makes
  // (right city, wrong unit / wrong date / wrong account) — as a clean 10/10.
  const expected = { name: 'book', args: { city: 'Paris', nights: 2 } } as any;

  it('all expected args present and equal scores 10', () => {
    const r = scoreToolCall([{ name: 'book', arguments: { city: 'Paris', nights: 2, ref: 'x' } }], expected);
    expect(r).toMatchObject({ score: 10, passed: true });
  });

  it('one of two expected args right is NOT a pass', () => {
    const r = scoreToolCall([{ name: 'book', arguments: { city: 'Paris', nights: 9 } }], expected);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(6);
  });

  it('a missing expected arg is NOT a pass', () => {
    const r = scoreToolCall([{ name: 'book', arguments: { city: 'Paris' } }], expected);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(6);
  });
});

describe('degenerate tool_call inputs are config errors, not crashes', () => {
  it('an expectedTool with no name is a config error', () => {
    // The guard is `!expected?.name`, but the only test passes `undefined`, so
    // weakening it to `!expected` survives. A test whose expectedTool exists but
    // has no `name` (a half-filled desktop form, a hand-written config) then
    // falls through and scores the CANDIDATE 2/10 for "called get_weather,
    // expected undefined" — blaming the model for the operator's mistake.
    const r = scoreToolCall([{ name: 'get_weather', arguments: {} }], {} as any);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/expectedTool/);
  });

  it('an EMPTY tool-call array scores 0 rather than throwing', () => {
    // `!toolCalls || toolCalls.length === 0` -> `!toolCalls` survived because no
    // test passes `[]`. Adapters normalise a text-only reply to an empty array,
    // and the mutant then reads `toolCalls[0].name` on undefined: a TypeError
    // inside scoring marks the node failed and wastes the call already billed.
    const r = scoreToolCall([], { name: 'get_weather' });
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail).toMatch(/no tool call/);
  });
});

describe('deepEqual is a two-way comparison', () => {
  // Two guards inside deepEqual are unreachable from the existing suite: the
  // key-count check (every test compares objects of the same size, or an actual
  // that is a SUPERSET) and the array/object check (no test compares one against
  // the other). Both decide whether a candidate matched the reference answer.

  it('an answer that OMITS an optional key does not equal the reference', () => {
    // Dropping `ka.length !== kb.length` makes deepEqual one-way: every key the
    // CANDIDATE emitted matches, so a strictly smaller answer "equals" the
    // reference. With `population` optional in the schema, the candidate can
    // simply leave it out and collect 10/10 for half an answer.
    const schema = {
      type: 'object',
      properties: { city: { type: 'string' }, population: { type: 'number' } },
      required: ['city'],
    } as object;
    const reference = '{"city":"Paris","population":2148000}';

    expect(scoreJsonSchema(reference, schema, undefined, reference).score).toBe(10);
    const halfAnswer = scoreJsonSchema('{"city":"Paris"}', schema, undefined, reference);
    expect(halfAnswer.passed).toBe(false);
    expect(halfAnswer.score).toBe(4); // conforms, wrong value
  });

  it('an empty object is not an empty array', () => {
    // `Array.isArray(a) !== Array.isArray(b)` is never exercised: without it
    // `{}` deep-equals `[]`, and `{"0":"x"}` deep-equals `["x"]`.
    const r = scoreToolCall(
      [{ name: 'f', arguments: { items: {} } }],
      { name: 'f', args: { items: [] }, argsMode: 'exact' } as any,
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(6);
  });
});

describe('a schema with no `required` list still scores a finite number', () => {
  it('a violating answer against a required-less schema is scored, not NaN', () => {
    // `required.length === 0 || !isPlainObject` -> `&&` survived because every
    // existing schema declares `required`. Without one the mutant divides by
    // `required.length` — zero — and satisfiedFraction returns NaN, so the test
    // result carries score NaN straight into the quality mean and the fitness
    // sort. A schema constrained only by `properties` + types is perfectly
    // ordinary.
    const schema = { type: 'object', properties: { a: { type: 'number' } } } as object;
    const r = scoreJsonSchema('{"a":"nope"}', schema);

    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(1);
    // Must stay strictly under the conforming-in-prose rung (5): this answer
    // violates the schema. The error-density fallback divisor is what keeps it
    // there, and widening it to 10 also survived.
    expect(r.score).toBeLessThan(5);
  });
});

describe('a key name containing "/" is scored like any other key', () => {
  it('RFC 6901 escaping keeps a slashed required key attributable', () => {
    // pointerFor escapes `~` and `/` so a required key matches its ajv
    // instancePath. Dropping the escaping survived: no schema in the suite has a
    // key needing it. The mutant then credits `a/b` as satisfied even though
    // ajv reported a type error on it, AND counts that error as unexplained —
    // so a wrong value scores HIGHER than the same wrong value under a plain key
    // name, purely because of the character in the name.
    const mk = (key: string) => ({
      type: 'object',
      required: [key, 'c'],
      properties: { [key]: { type: 'string' }, c: { type: 'string' } },
    }) as object;

    const plain = scoreJsonSchema('{"ab":1,"c":"ok"}', mk('ab')).score;
    const slashed = scoreJsonSchema('{"a/b":1,"c":"ok"}', mk('a/b')).score;

    expect(slashed).toBe(plain);
  });
});

describe('the prose-extraction ladder is ordered at its LOWEST rung too', () => {
  it('a schema-VIOLATING extraction stays below both wrong-value rungs', () => {
    // structured.ts caps this rung "BELOW the conforming-but-wrong rung (4) and
    // the wrong-in-prose rung (3)". The cap is only reachable with enough
    // required keys for the diminishing penalty to stay small — 6 or more —
    // and every schema in the suite has 1 to 5, so relaxing the cap is
    // invisible. Relaxed, a violating answer TIES a conforming one with the
    // wrong values, and the gradient stops pointing at conformance.
    const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const schema = {
      type: 'object', additionalProperties: false, required: KEYS,
      properties: Object.fromEntries(KEYS.map(k => [k, { type: 'string' }])),
    } as object;
    const right = Object.fromEntries(KEYS.map((k, i) => [k, String(i)]));
    const wrong = Object.fromEntries(KEYS.map(k => [k, 'ZZZ']));
    const ref = JSON.stringify(right);
    const score = (out: string) => scoreJsonSchema(out, schema, undefined, ref).score;

    const cleanCorrect = score(ref);
    const proseCorrect = score(`Here you go: ${ref}`);
    const cleanWrong = score(JSON.stringify(wrong));
    const proseWrong = score(`Here you go: ${JSON.stringify(wrong)}`);
    // Every required key present AND correct, plus one additionalProperties
    // violation: the highest a violating document can score.
    const proseViolating = score(`Here you go: ${JSON.stringify({ ...right, extra: 1 })}`);

    expect(cleanCorrect).toBe(10);
    expect(proseCorrect).toBe(5);
    expect(cleanWrong).toBe(4);
    expect(proseWrong).toBe(3);
    expect(proseViolating).toBeLessThan(proseWrong);
  });
});

describe('only TOP-LEVEL spans are extracted from prose', () => {
  it('an ARRAY answer buried inside a wrapper object does not earn the prose rung', () => {
    // balancedSpans scans `{}` and `[]` independently and then drops any span
    // nested inside one already taken. Removing that drop survived: the only
    // existing test for it uses an OBJECT schema, where the nested array scores
    // 1 and best-of-N hides the difference. Reverse the shapes and it is a free
    // upgrade for a contract break — wrap the required array in any key and the
    // extractor scores the INNER array 5 (conforming-in-prose) instead of the
    // object the model actually emitted, which does not conform at all.
    const schema = { type: 'array', items: { type: 'string' } } as object;

    const flat = scoreJsonSchema('Here you go: ["alpha","beta"]', schema);
    const wrapped = scoreJsonSchema('Here you go: {"answer":["alpha","beta"]}', schema);

    expect(flat.score).toBe(5);
    expect(wrapped.score).toBeLessThan(flat.score);
    expect(wrapped.score).toBeLessThanOrEqual(2);
  });
});
