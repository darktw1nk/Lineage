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

/** Parse candidates: the whole text, then the first balanced {...} / [...] span. */
function jsonCandidates(raw: string): string[] {
  const text = stripFences(raw);
  const out = [text];
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
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
      else if (ch === close) {
        depth--;
        if (depth === 0) { out.push(text.slice(start, i + 1)); break; }
      }
    }
  }
  return out;
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

/**
 * Partial credit for non-conforming output, as the FRACTION OF THE SCHEMA
 * SATISFIED — not the raw ajv error count. Counting errors inverts the
 * gradient: a nearly-correct object trips one error per missing field, while a
 * bare scalar trips exactly one root-type error and would score higher.
 */
function satisfiedFraction(parsed: unknown, schema: any, errorCount: number): number {
  if (schema?.type && !matchesType(parsed, schema.type)) return 0; // wrong shape entirely

  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  if (required.length > 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    let ok = 0;
    for (const key of required) {
      const value = (parsed as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const propSchema = schema.properties?.[key];
      if (!propSchema) { ok++; continue; } // present and unconstrained
      try {
        const cacheKey = `prop:${JSON.stringify(propSchema)}`;
        let validate = validatorCache.get(cacheKey);
        if (!validate) {
          validate = ajv.compile(propSchema);
          validatorCache.set(cacheKey, validate);
        }
        if (validate(value)) ok++;
      } catch {
        ok++; // uncompilable sub-schema: don't punish the candidate
      }
    }
    return ok / required.length;
  }

  // No required list to measure against: fall back to error density
  return Math.max(0, 1 - errorCount / 5);
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

  // Try the whole output, then the first balanced JSON span (models often wrap
  // valid JSON in prose). First candidate that parses wins.
  let parsed: unknown;
  let parseError: unknown;
  let found = false;
  for (const candidate of jsonCandidates(output)) {
    try {
      parsed = JSON.parse(candidate);
      found = true;
      break;
    } catch (error) {
      parseError ??= error;
    }
  }
  if (!found) {
    return { passed: false, score: 0, detail: `invalid JSON: ${parseError instanceof Error ? parseError.message : parseError}` };
  }

  if (validate(parsed)) return { passed: true, score: 10, detail: 'conforms to schema' };

  const errors = validate.errors ?? [];
  // 1..5 by fraction of the schema satisfied: more nearly-correct scores higher,
  // and a totally wrong shape lands at the floor.
  const fraction = satisfiedFraction(parsed, schema as any, errors.length);
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
