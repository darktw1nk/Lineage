/**
 * Deterministic scorers for the agent-builder test modes. No judge calls:
 * scoring is free, noise-free, and gives evolution a crisp gradient.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { TestCase } from '../types.js';

const ajv = new Ajv({ strict: false, allErrors: true });
const validatorCache = new Map<string, ValidateFunction>();

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return text;
}

/**
 * Every TOP-LEVEL balanced {...} / [...] span, ordered by where it starts.
 *
 * Each bracket type is scanned independently, then the results are merged in
 * START order and spans contained inside another are dropped. Both halves
 * matter, and each was a bug on its own:
 *
 * - Concatenating the two passes (objects then arrays) put EVERY array span
 *   after every object span, so an array nested inside the answer object
 *   outranked the object — a prose-wrapped conforming object with any array
 *   field scored 1, the same as garbage.
 * - Merging them into a single left-to-right pass fixed that but made ONE
 *   unterminated bracket abort all extraction: `if (x) { return;` earlier in
 *   the reply hid a perfectly good `["alpha","beta"]` later in it.
 *
 * Scanning per type keeps an unbalanced `{` from blocking `[…]`, and stopping
 * that type at its first unterminated opener keeps the cost linear.
 */
function balancedSpans(text: string): string[] {
  const found: Array<{ start: number; end: number }> = [];

  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(open, cursor);
      if (start === -1) break;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) { end = i; break; }
      }
      if (end === -1) break; // this TYPE cannot balance further; the other still might
      found.push({ start, end });
      cursor = end + 1;
    }
  }

  found.sort((a, b) => a.start - b.start);

  const spans: string[] = [];
  let lastEnd = -1;
  for (const span of found) {
    if (span.start <= lastEnd) continue; // nested inside a span we already took
    spans.push(text.slice(span.start, span.end + 1));
    lastEnd = span.end;
  }
  return spans;
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some(t => {
    switch (t) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: return true; // unknown/absent type constraint doesn't disqualify
    }
  });
}

/** RFC 6901 escaping, so a key containing '/' or '~' matches its instancePath. */
function pointerFor(key: string): string {
  return '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Partial credit for non-conforming output.
 *
 * Two failure modes have to be told apart, and the raw ajv error count cannot
 * do it: a nearly-correct object trips one error per missing field, while a
 * bare scalar trips exactly one root-type error — so counting errors made
 * garbage outrank near-misses.
 *
 * So credit is the fraction of REQUIRED keys actually satisfied, discounted by
 * violations that missing keys don't explain. Without that discount the
 * gradient inverted the other way: an object with every required key present
 * plus four additionalProperties violations hit the ceiling, while a strictly
 * closer object missing one key scored lower.
 *
 * A key counts as satisfied when it is present and ajv reported no error at or
 * beneath its path. Reading it off the root validation (rather than compiling
 * each property sub-schema standalone) is what makes $ref work: an extracted
 * `{$ref: '#/definitions/…'}` cannot compile on its own, and the old
 * catch-and-credit handed those properties full marks unconditionally.
 */
function satisfiedFraction(parsed: unknown, schema: any, errors: ReadonlyArray<any>): number {
  if (schema?.type && !matchesType(parsed, schema.type)) return 0; // wrong shape entirely

  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const isPlainObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  if (required.length === 0 || !isPlainObject) {
    // No required list to measure against: fall back to error density
    return Math.max(0, 1 - errors.length / 5);
  }

  let ok = 0;
  for (const key of required) {
    if ((parsed as Record<string, unknown>)[key] === undefined) continue;
    const pointer = pointerFor(key);
    const faulty = errors.some(e =>
      typeof e.instancePath === 'string' &&
      (e.instancePath === pointer || e.instancePath.startsWith(`${pointer}/`)),
    );
    if (!faulty) ok++;
  }

  // "Other" means errors NOT already reflected in `ok` above.
  //
  // A required key that is present but faulty is counted once by failing to
  // increment `ok`. Counting its error here too penalised it a SECOND time, so
  // omitting a required field beat attempting it with the wrong type: with
  // required [name, age], `{"name":"Bob"}` scored 3 and
  // `{"name":"Bob","age":"31"}` scored 2. That teaches a model to leave fields
  // out, which is the opposite of what the schema is asking for.
  const explainedByMissingKey = (e: any) =>
    e.keyword === 'required' && required.includes(e.params?.missingProperty);
  const explainedByFaultyRequiredKey = (e: any) =>
    typeof e.instancePath === 'string' &&
    required.some(key => {
      const pointer = pointerFor(key);
      return e.instancePath === pointer || e.instancePath.startsWith(`${pointer}/`);
    });
  const otherErrors = errors.filter(
    e => !explainedByMissingKey(e) && !explainedByFaultyRequiredKey(e),
  ).length;

  // A DIMINISHING penalty, never a saturating one.
  //
  // `min(1, otherErrors / N)` hit 1 and stayed there, so past that point every
  // candidate collapsed to the same floor: an answer with all required keys
  // correct plus five extra fields scored identically to a bare string. Halving
  // the remaining credit per error keeps the ordering strict all the way down —
  // more wrong is always worth less, and never exactly zero while the required
  // keys are right.
  const penalty = 1 - 0.5 ** (otherErrors / Math.max(1, required.length));

  return (ok / required.length) * (1 - penalty);
}

export function scoreJsonSchema(
  output: string,
  schema: object | undefined,
  cacheKey?: string,
  /**
   * The reference answer, when the test provides one. Without it this mode
   * scores SHAPE ONLY: one fixed reply such as `{"city":"x","population":0}`
   * validates and scored 10/10 on EVERY json_schema test in a set regardless of
   * what was asked — a free perfect score for zero task ability, which is
   * exactly the gradient evolution climbs.
   */
  expected?: string,
): { passed: boolean; score: number; detail: string } {
  if (!schema) return { passed: false, score: 0, detail: 'no schema configured on this json_schema test' };

  let validate: ValidateFunction | undefined;
  try {
    // Cache key must include the schema CONTENT: test ids are stable across
    // edits, and this module outlives runs in the Electron main process — an
    // id-only key would keep scoring against a stale compiled schema.
    const key = cacheKey ? `${cacheKey}:${JSON.stringify(schema)}` : undefined;
    validate = key ? validatorCache.get(key) : undefined;
    if (!validate) {
      validate = ajv.compile(schema);
      if (key) validatorCache.set(key, validate);
    }
  } catch (error) {
    return { passed: false, score: 0, detail: `schema error: ${error instanceof Error ? error.message : error}` };
  }

  const text = stripFences(output);

  // When a reference is given, VALUES must match too. Shape alone is not the
  // task; it is the format the task must be delivered in.
  let unsatisfiableReference = false;
  const expectedValue = (() => {
    if (expected === undefined || expected === null || expected === '') return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(stripFences(expected)); } catch { return undefined; }
    // The reference must itself CONFORM, or no output can both validate and
    // equal it — so every conforming candidate, perfect or garbage, is capped at
    // 6 with `passed` permanently false, and the test carries zero signal.
    // docs/cli.md documents `expected` as used by exact_match only, so it is
    // routinely set on json_schema tests where it used to be inert; the
    // desktop's mode switch is a merge, so it can also be left behind invisibly.
    // An unsatisfiable reference is ignored, loudly.
    if (!validate(parsed)) {
      unsatisfiableReference = true;
      return undefined;
    }
    return parsed;
  })();

  // A reference that cannot satisfy its own schema is a CONFIG error, and it
  // must not be papered over in either direction. Comparing against it capped
  // every conforming answer at a failing 4; ignoring it handed every answer,
  // including a constant stub, a passing 10 — the exact free score the
  // `expected` parameter was added to close, now with passed:true feeding
  // pass-rate reporting and targetFitness. Fail closed and name the fix.
  if (unsatisfiableReference) {
    // Say it on stderr too. The reason lived ONLY in results.json's leaf, so
    // the report printed a bare `Score: 0/10` beside a visibly perfect answer
    // with no explanation anywhere a user looks, and a config error is always
    // zero-delta, which is exactly the row the report drops the reason from.
    console.warn(
      '[Structured] CONFIG ERROR: a json_schema test has an `expected` value that is not a valid ' +
      'instance of its own schema, so no answer can match it. Every candidate scores 0 on that test ' +
      'until you remove `expected` or make it conform.',
    );
    return {
      passed: false,
      score: 0,
      detail:
        'CONFIG ERROR: this json_schema test has an `expected` value that is not a valid instance of ' +
        'its own schema, so no answer could ever match it. Remove `expected`, or make it conform.',
    };
  }


  // 1. The whole response. This is the only candidate that can earn a perfect
  //    score — a model that wraps its JSON in prose has failed the
  //    structured-output contract, and letting that reach 10 handed evolution a
  //    reward-hacking gradient (an output that merely echoed the schema
  //    template while refusing the task validated and scored 10).
  let wholeTextParsed: unknown;
  let parsed = false;
  try {
    wholeTextParsed = JSON.parse(text);
    parsed = true;
  } catch { /* fall through to extraction */ }

  if (parsed) {
    if (validate(wholeTextParsed)) {
      if (expectedValue !== undefined && !deepEqual(wholeTextParsed, expectedValue)) {
        // Right shape, wrong answer. Scored between a prose-wrapped conformer
        // (5) and a clean correct one (10): the format contract WAS met.
        return {
          passed: false,
          // BELOW the prose-wrapped conformer at 5. Scoring 6 put a cleanly
          // formatted WRONG answer above a CORRECT one that happened to be
          // wrapped in prose — rewarding format over correctness, which is
          // backwards, and formatting is exactly what a constant stub gets free.
          score: 4,
          detail: `conforms to schema but does not match the expected value: expected ${safeStringify(expectedValue)}, got ${safeStringify(wholeTextParsed)}`,
        };
      }
      return { passed: true, score: 10, detail: 'conforms to schema' };
    }
    const errors = validate.errors ?? [];
    // 1..5 by fraction of the schema satisfied: more nearly-correct scores
    // higher, and a totally wrong shape lands at the floor.
    const fraction = satisfiedFraction(wholeTextParsed, schema as any, errors);
    return {
      passed: false,
      // Capped BELOW the conforming-but-wrong rung when a reference exists.
      // At Math.min(5, ...) a schema-VIOLATING answer reached 5, above the 4
      // given to a CONFORMING one with wrong values — so adding a junk key to a
      // wrong answer paid +1, at any schema with 6+ required keys, which is
      // ordinary. That is the same 'breaking the contract pays' shape fixed one
      // rung over for prose, reopened here.
      score: Math.min(expectedValue !== undefined ? 3 : 5, Math.max(1, Math.round(1 + 4 * fraction))),
      detail: `schema violations (${errors.length}, ${Math.round(fraction * 100)}% of required satisfied): ` +
        errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; '),
    };
  }

  // 2. Dig JSON out of prose. Score EVERY span and keep the best, rather than
  //    picking by position: preferring the first span scored a leading
  //    placeholder example, and preferring the last one scored a trailing
  //    "for reference, the schema was {...}" blob. Both are common, and both
  //    threw away the real answer sitting right next to it.
  let best: { passed: boolean; score: number; detail: string } | null = null;
  for (const span of balancedSpans(text)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(span);
    } catch {
      continue;
    }
    const result = validate(candidate)
      ? (expectedValue !== undefined && !deepEqual(candidate, expectedValue)
          // The prose rung never consulted the reference, so moving the clean
          // wrong-value rung to 4 put it BELOW prose — wrapping a wrong answer
          // in prose paid +1, rewarding exactly the contract break this mode
          // exists to punish. Correctness dominates format at every rung:
          //   clean+correct 10 > prose+correct 5 > clean+wrong 4 > prose+wrong 3
          ? { passed: false, score: 3, detail: 'valid JSON inside prose, and it does not match the expected value' }
          : { passed: false, score: 5, detail: 'valid JSON found inside prose — the response itself was not JSON' })
      : (() => {
          const errors = validate.errors ?? [];
          const fraction = satisfiedFraction(candidate, schema as any, errors);
          return {
            passed: false,
            // Capped below a conforming extraction, so the ordering
            // clean (10) > conforming-in-prose (5) > broken-in-prose (<=4) holds.
            // Capped BELOW the conforming-but-wrong rung (4) and the
            // wrong-in-prose rung (3). Math.min(5, ...) let a schema-VIOLATING
            // answer reach 5 — above a conforming one with wrong values — at any
            // schema with 6+ required keys, which is ordinary. The gradient then
            // pointed away from conformance, which is the whole contract.
            score: Math.min(2, Math.max(1, Math.round(1 + 4 * fraction))),
            detail: `JSON found inside prose, and it violates the schema (${errors.length}): ` +
              errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; '),
          };
        })();
    if (!best || result.score > best.score) best = result;
    if (best.score === 5) break; // nothing extracted can beat a conforming span
  }

  if (best) return best;
  return { passed: false, score: 0, detail: 'invalid JSON: no parseable JSON found in the response' };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

export function scoreToolCall(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined,
  expected: TestCase['expectedTool'],
): { passed: boolean; score: number; detail: string } {
  if (!expected?.name) {
    return { passed: false, score: 0, detail: 'no expectedTool configured on this tool_call test' };
  }
  if (!toolCalls || toolCalls.length === 0) {
    return { passed: false, score: 0, detail: 'no tool call (plain text response)' };
  }

  // EXTRA calls are a failure, not something to look past. Only toolCalls[0]
  // was judged, so `correct_call + delete_everything` scored a clean 10/10 and
  // the destructive second call was invisible to the ladder. A test that asks
  // for one tool call and gets three did not pass.
  if (toolCalls.length > 1) {
    const extras = toolCalls.slice(1).map(c => c.name).join(', ');
    return {
      passed: false,
      score: 2,
      detail: `made ${toolCalls.length} tool calls, expected 1 (extra: ${extras})`,
    };
  }

  const call = toolCalls[0];
  if (call.name !== expected.name) {
    return { passed: false, score: 2, detail: `called ${call.name}, expected ${expected.name}` };
  }
  if (!expected.args) {
    return { passed: true, score: 10, detail: `called ${expected.name} (no argument expectations)` };
  }

  const mode = expected.argsMode ?? 'subset';
  const matches = mode === 'exact'
    ? deepEqual(call.arguments, expected.args)
    : Object.entries(expected.args).every(([k, v]) => deepEqual((call.arguments as any)[k], v));

  if (matches) return { passed: true, score: 10, detail: `called ${expected.name} with matching args (${mode})` };
  return {
    passed: false,
    score: 6,
    // JSON.parse accepts nesting far deeper than JSON.stringify can emit
    // (~156k vs ~819), so a deeply-nested tool argument was ACCEPTED and then
    // threw RangeError here — marking the node failed and wasting the call that
    // had already been billed. Formatting a diff must never fail the scoring.
    detail: `called ${expected.name} but args differ (${mode}): expected ${safeStringify(expected.args)}, got ${safeStringify(call.arguments)}`,
  };
}

/** JSON.stringify that degrades instead of throwing on pathological input. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[too deeply nested to display]';
  }
}
