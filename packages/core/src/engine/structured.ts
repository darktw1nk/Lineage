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

/** Every balanced {...} / [...] span in the text, in the order they start. */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    let cursor = 0;
    for (;;) {
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
      if (end === -1) break;
      spans.push(text.slice(start, end + 1));
      cursor = end + 1;
    }
  }
  return spans;
}

/**
 * Parse candidates, best first.
 *
 * The whole text is tried first and is the only candidate that can earn a
 * perfect score. Digging JSON out of prose is a fallback, and it is deliberately
 * scored below a clean emit: a model that says "Sure! Here you go: {...}" has
 * failed the structured-output contract, and letting that reach 10 handed
 * evolution a reward-hacking gradient (an output that merely *echoed the schema
 * template* while refusing the task validated and scored a perfect 10).
 *
 * Spans are tried LAST first, so "Example: {...placeholder...} Real answer:
 * {...}" is scored on the real answer rather than the example.
 */
function jsonCandidates(raw: string): Array<{ text: string; extracted: boolean }> {
  const text = stripFences(raw);
  const spans = balancedSpans(text);
  return [
    { text, extracted: false },
    ...spans.reverse().map(span => ({ text: span, extracted: true })),
  ];
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
  const penalty = Math.min(1, otherErrors / required.length);

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

  let parsed: unknown;
  let parseError: unknown;
  let extracted = false;
  let found = false;
  for (const candidate of jsonCandidates(output)) {
    try {
      parsed = JSON.parse(candidate.text);
      extracted = candidate.extracted;
      found = true;
      break;
    } catch (error) {
      parseError ??= error;
    }
  }
  if (!found) {
    return { passed: false, score: 0, detail: `invalid JSON: ${parseError instanceof Error ? parseError.message : parseError}` };
  }

  const conforms = validate(parsed);

  // Prose-wrapped JSON is a format failure, not a pass: an API consumer calling
  // JSON.parse on this response would throw. It earns partial credit only, so
  // clean output (10) always outranks output we had to dig out (5).
  if (extracted) {
    if (conforms) {
      return { passed: false, score: 5, detail: 'valid JSON found inside prose — the response itself was not JSON' };
    }
    const errors = validate.errors ?? [];
    const fraction = satisfiedFraction(parsed, schema as any, errors);
    const score = Math.min(4, Math.max(1, Math.round(1 + 4 * fraction)));
    return {
      passed: false,
      score,
      detail: `JSON found inside prose, and it violates the schema (${errors.length}): ` +
        errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; '),
    };
  }

  if (conforms) return { passed: true, score: 10, detail: 'conforms to schema' };

  const errors = validate.errors ?? [];
  // 1..5 by fraction of the schema satisfied: more nearly-correct scores higher,
  // and a totally wrong shape lands at the floor.
  const fraction = satisfiedFraction(parsed, schema as any, errors);
  const score = Math.min(5, Math.max(1, Math.round(1 + 4 * fraction)));
  const detail = `schema violations (${errors.length}, ${Math.round(fraction * 100)}% of required satisfied): ` +
    errors.slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
  return { passed: false, score, detail };
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
