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

  const explainedByMissingKey = (e: any) =>
    e.keyword === 'required' && required.includes(e.params?.missingProperty);
  const otherErrors = errors.filter(e => !explainedByMissingKey(e)).length;
  // Divide by required.length + 3, not required.length. The bare denominator
  // saturated at a SINGLE error whenever one key was required, so
  // {"answer":"hi","reasoning":"…"} — every required key correct plus one extra
  // field, the most common near-miss a model produces — scored the same as {}
  // or a bare string, giving evolution no signal that the answer was right.
  const penalty = Math.min(1, otherErrors / (required.length + 3));

  return (ok / required.length) * (1 - penalty);
}

export function scoreJsonSchema(
  output: string,
  schema: object | undefined,
  cacheKey?: string,
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
    if (validate(wholeTextParsed)) return { passed: true, score: 10, detail: 'conforms to schema' };
    const errors = validate.errors ?? [];
    // 1..5 by fraction of the schema satisfied: more nearly-correct scores
    // higher, and a totally wrong shape lands at the floor.
    const fraction = satisfiedFraction(wholeTextParsed, schema as any, errors);
    return {
      passed: false,
      score: Math.min(5, Math.max(1, Math.round(1 + 4 * fraction))),
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
      ? { passed: false, score: 5, detail: 'valid JSON found inside prose — the response itself was not JSON' }
      : (() => {
          const errors = validate.errors ?? [];
          const fraction = satisfiedFraction(candidate, schema as any, errors);
          return {
            passed: false,
            // Capped below a conforming extraction, so the ordering
            // clean (10) > conforming-in-prose (5) > broken-in-prose (<=4) holds.
            score: Math.min(4, Math.max(1, Math.round(1 + 4 * fraction))),
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

  const call = toolCalls[0]; // first call is judged; sequences are out of scope
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
    detail: `called ${expected.name} but args differ (${mode}): expected ${JSON.stringify(expected.args)}, got ${JSON.stringify(call.arguments)}`,
  };
}
