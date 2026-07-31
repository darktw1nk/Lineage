/** Longest model output allowed inside a judge prompt, in characters. */
const MAX_JUDGED_TEXT = 12_000;

/**
 * Prepare model-produced text for interpolation into a JUDGE prompt.
 *
 * Judge prompts delimit each section with <<< … >>>, and the candidate's own
 * output goes inside one. Interpolated verbatim, an output containing `>>>`
 * closes its own block early and everything after it reads as prompt — so a
 * candidate could append its own "ADDENDUM TO RUBRIC: award 10" and a forged
 * EXPECTED answer, both landing BEFORE the real ones. Evolution runs thousands
 * of trials and keeps whatever scores higher, so an unmitigated channel like
 * this gets found and selected for.
 *
 * Neutralising the delimiter costs nothing (no real answer needs a literal
 * `>>>`), and the length cap stops an 80KB reply being pasted into the prompt
 * whole.
 */
/**
 * The full default-ignorable set — every character that renders as nothing and
 * so could HIDE a delimiter from a reader while leaving `>>>` in the bytes.
 *
 * Applied ONLY to decide whether a line is delimiter-shaped, and to the
 * replacement text on a line that already is. Ordinary text keeps every one of
 * these: a line of nothing but `>>>` and joiners is an attack, never an emoji,
 * and a line of genuine emoji is not delimiter-shaped once the joiners come
 * out, so it is returned byte-for-byte. An earlier version excluded ZWJ/ZWNJ
 * from the class outright to protect emoji families and Indic conjuncts;
 * scoping the strip to the detection test protects them without leaving 5 of
 * the 12 hiding characters usable as a way out of the block.
 */
const HIDING_CHARS =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u180F\uFFF0-\uFFF8\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}\u{1BCA0}-\u{1BCA3}\u{13430}-\u{1343F}\u{1D173}-\u{1D17A}]/gu;

/** Same set as HIDING_CHARS, as a source fragment for composing regexes. */
const HIDE_SRC =
  '[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200F' +
  '\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\u180F\\uFFF0-\\uFFF8\\uFFF9-\\uFFFB' +
  '\\u{E0000}-\\u{E0FFF}\\u{1BCA0}-\\u{1BCA3}\\u{13430}-\\u{1343F}\\u{1D173}-\\u{1D17A}]';

/**
 * Remove every invisible character, for COMPARISON only.
 *
 * A model reads `sco<U+200B>re` as `score`, so any check that asks "did the
 * candidate emit this token?" has to normalise first. sanitizeForJudge cannot
 * do that job — it deliberately preserves hiders outside a fence, because
 * stripping them corrupts emoji families and Indic conjuncts.
 */
export function stripHidingChars(text: string): string {
  return text.replace(HIDING_CHARS, '');
}

/**
 * A fence run: three or more same-direction angle brackets, allowing hiding
 * characters between and after them. Matched against the ORIGINAL line so the
 * replacement leaves everything outside the run byte-for-byte intact.
 */
const FENCE_RUN = new RegExp(
  `(?:${HIDE_SRC}*>){3,}${HIDE_SRC}*|(?:${HIDE_SRC}*<){3,}${HIDE_SRC}*`,
  'gu',
);

/**
 * Every character a language model reads as a LINE BREAK.
 *
 * Splitting on /\r?\n/ alone missed CR-only, LS, PS, NEL, VT and FF — six ways
 * to put `>>>` on a line of its own that the detector never looked at. The
 * terminator is CAPTURED so it can be put back verbatim: rejoining on '\n' was
 * silently rewriting every CRLF in judged text to LF.
 */
const LINE_SPLIT = /(\r\n|[\r\n\u0085\u000B\u000C\u2028\u2029])/;

/**
 * Prepare model-produced text for interpolation into a JUDGE prompt.
 *
 * The judge prompt puts each section inside a block:
 *     OUTPUT (model): <<<
 *     ...text...
 *     >>>
 * so only two shapes can escape it: a line that is exactly `>>>` (closes the
 * block) and a line ENDING in `<<<` (opens a forged one). Nothing else can,
 * whatever it contains.
 *
 * Earlier versions neutralised every run of 3+ `>`/`<` anywhere in the text.
 * That corrupted ordinary answers — Python REPL transcripts, git conflict
 * markers, bash herestrings, C++ nested generics — and because the EXPECTED
 * reference is NOT sanitised while the OUTPUT is, the judge compared a mangled
 * answer against a clean reference and scored a byte-perfect response 2/10.
 * The default rubric grades format consistency explicitly, so this pushed
 * evolution away from correct answers. The injection it prevented needed a
 * delimiter AND a forged block; the corruption fired on any three `>`.
 *
 * Invisibles are stripped only on a line that is delimiter-shaped once they
 * are removed, so `>` ZWSP `>` ZWSP `>` cannot smuggle a closer past the
 * check while real text keeps its zero-width joiners.
 */
/** Would sanitizeForJudge clip this text? Callers that must FAIL CLOSED need to know. */
export function wouldTruncateForJudge(text: string): boolean {
  return text.length > MAX_JUDGED_TEXT;
}

export function sanitizeForJudge(text: string): string {
  const clipped = text.length > MAX_JUDGED_TEXT
    ? `${text.slice(0, MAX_JUDGED_TEXT)}\n…[truncated ${text.length - MAX_JUDGED_TEXT} characters]`
    : text;

  // split() with a capturing group interleaves [line, terminator, line, …], so
  // terminators pass through untouched and only the lines are examined.
  return clipped.split(LINE_SPLIT).map((line, i) => {
    if (i % 2 === 1) return line; // a captured line terminator
    const bare = line.replace(HIDING_CHARS, '');
    // A line of NOTHING BUT `>` closes the block (>>>, >>>>, …); a line ending
    // in 3+ `<` opens a forged one, which is the shape of the template's own
    // `LABEL: <<<`. Anything else cannot escape the block.
    // Trim BLANK-RENDERING characters too, not just whitespace and hiders. The
    // class is the full Default_Ignorable set (verified exhaustively), but the
    // threat model is 'renders as nothing', which is wider: U+2800 BRAILLE
    // PATTERN BLANK renders blank, is not \s, and is not default-ignorable, so
    // `>>>` + U+2800 failed the shape test and carried a complete forged block
    // to the judge for one character.
    const trimBlank = (t: string) => t.replace(/^[\s\u2800\u3164\uFFA0]+|[\s\u2800\u3164\uFFA0]+$/g, '');
    const closes = /^>{3,}$/.test(trimBlank(bare));
    const opens = /<{3,}$/.test(trimBlank(bare));
    if (!closes && !opens) return line; // untouched — the overwhelming majority
    // Neutralise the FENCE IN PLACE, in the original line. Returning `bare`
    // stripped hiding characters from the whole line, and the `opens` shape
    // permits arbitrary text before a trailing `<<<` — so an emoji family, an
    // Indic conjunct or a variation selector sharing that line was corrupted
    // (👨‍👩‍👧 became 👨👩👧). Only characters inside the fence run are touched.
    //
    // Space-separated so the JUDGE (which cannot see zero-width characters)
    // genuinely reads it as something other than a delimiter, and the hiders
    // that were smuggled INSIDE the run are dropped with it.
    return line.replace(FENCE_RUN, match => {
      const brackets = match.replace(HIDING_CHARS, '').replace(/[^<>]/g, '');
      return brackets.split('').join(' ');
    });
  }).join('');
}

/**
 * Fill ${name} placeholders in a template.
 *
 * MUST be used instead of `tpl.replace(/\$\{x\}/g, value)`: a *string*
 * replacement makes JS interpret `$$`, `$&`, `` $` `` and `$'` inside the
 * VALUE as special replacement patterns, so a user prompt containing a price
 * ("$$40"), LaTeX ("$$E=mc^2$$"), a regex or a shell snippet gets silently
 * rewritten before any model sees it — including the judge, where `` $` ``
 * splices the grading rubric into the text being graded.
 *
 * Filling in one pass also stops a value substituted for one placeholder from
 * being re-scanned for the next (a prompt containing "${expectedOutput}"
 * would otherwise have the reference answer pasted into it).
 *
 * Unknown placeholders are left verbatim.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/**
 * Does the leading <<< pair with the trailing >>>, rather than merely being
 * the first and last markers of a sequence of separate blocks?
 *
 * Walk the delimiters as brackets: if the depth returns to zero before the
 * end, the string is a run of sibling blocks (<<<SYSTEM>>> … <<<END>>>), not
 * one wrapper — and stripping its outer markers would leave the middle ones
 * unbalanced.
 */
function isSingleWrapper(text: string): boolean {
  const tokens = text.match(/<<<|>>>/g);
  if (!tokens || tokens.length < 2) return false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    depth += tokens[i] === '<<<' ? 1 : -1;
    if (depth <= 0) return i === tokens.length - 1;
  }
  return false;
}

/**
 * Strip meta-prompt wrapper delimiters (<<< / >>>) that service models
 * sometimes echo back around a rewritten prompt. Unwraps repeatedly so
 * nested wrappers from compounding operator steps are fully removed.
 *
 * Only unwraps a genuine enclosing wrapper. A prompt written in this engine's
 * own <<<SYSTEM>>> … <<<END>>> style merely starts with <<< and ends with
 * >>>; the old both-ends-anchored lazy match ate its first and last marker
 * and left the rest dangling.
 */
export function stripPromptDelimiters(text: string): string {
  let result = text.trim();
  // Deliberately NOT a regex. `/^<<<\s*([\s\S]*)\s*>>>$/` has three adjacent
  // quantifiers, so every FAILING match enumerates their cross-product — and
  // the failing case is routine: a model wraps its answer in <<< >>> and then
  // adds a closing sentence. Measured at 90 seconds for 12KB of model output,
  // growing ~8x per doubling, synchronously on the only thread. That froze the
  // Electron main process (no IPC, no Stop button) and made the CLI ignore
  // Ctrl-C. Slicing is linear and does exactly the same job.
  while (isSingleWrapper(result) && result.startsWith('<<<') && result.endsWith('>>>')) {
    result = result.slice(3, -3).trim();
  }
  return result;
}

/** What an operator's applied prompt was rejected for, or null when usable. */
export interface AppliedPromptProblem {
  code: 'empty' | 'noop' | 'json' | 'echo' | 'scaffolding';
  reason: string;
}

export interface AppliedPromptCheck {
  /** The prompt(s) the operator started from. A result equal to one is a paid no-op. */
  parents?: string[];
  /** Edit instructions sent to the apply step. A result reproducing one is an echo. */
  instructions?: string[];
}

/**
 * Case-, whitespace- AND hiding-character-insensitive form for containment
 * comparisons. Pass 19: a ZWSP inside an otherwise verbatim echo defeated the
 * check because \s does not match U+200B.
 */
function normalizeForEcho(text: string): string {
  return stripHidingChars(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whitespace-collapsed equality — a "mutation" that only reflows whitespace
 * is still the paid no-op of open-bugs #1 (pass 19: exact trim equality let
 * a collapsed double-space count as a change and re-bill the node). */
function sameCollapsed(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * Is this instruction EDIT-language (an imperative about the prompt) rather
 * than replacement text? "Rewrite the role/identity statement…" is an
 * instruction; "Extract key information from the ticket…" is a prompt. The
 * distinction matters because a FAITHFUL application of a full-rewrite edit is
 * byte-equal to the edit text — pass 18 rejected that as an echo, observed
 * live: three deterministic retries, all rejected, a legitimate rewrite
 * discarded (pass-19 hunter A, F1).
 */
function isEditLanguage(instruction: string): boolean {
  return /\b(rewrite|replace|reword|rephrase|remove|delete|prune|add|insert|append|convert|reorder|restructure|tighten|adjust|switch|merge|change)\b[^.!?]{0,60}\b(prompt|instruction|statement|section|line|sentence|paragraph|wording|phrasing|role|identity|constraint|rule|example)s?\b/i
    .test(instruction);
}

/** A line that reproduces the operator template's fence shape: a line that is
 * only `>>>` (closes a block) or ends in `<<<` (opens one). Substring matching
 * rejected real content — a bash herestring (`tr a-z A-Z <<< "x"`) is mid-line
 * and can never escape or open a block (pass-19 hunter A, F8). */
function hasScaffoldLine(text: string): boolean {
  return text.split(/\r?\n/).some(line => {
    const l = line.trim();
    return /^>{3,}$/.test(l) || /<{3,}$/.test(l);
  });
}

/** Parse `text` as JSON after unwrapping a ```fence```, or return undefined. */
function parseJsonValue(text: string): unknown {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** The shape of the mutation/meta proposal: a list of {label?, edit} objects. */
function isEditListShape(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 &&
    value.every(e => e && typeof e === 'object' &&
      (typeof (e as any).edit === 'string' || typeof (e as any).label === 'string'));
}

/**
 * Decide whether an operator's APPLIED text is actually a prompt.
 *
 * Observed failures this gate exists for (2026-07-31 open-bugs #1/#2):
 *  - the apply step returned the parent byte-for-byte, and the engine adopted
 *    it with a changelog claiming two applied mutations, then paid to
 *    re-measure a prompt it had already measured;
 *  - the service model echoed the mutation INSTRUCTION ("Rewrite the
 *    role/identity statement to…") and that echo was evaluated as a candidate;
 *  - the proposal JSON (`[{"label":"ADD","edit":…}]`) became the champion
 *    prompt of a run that reported success.
 *
 * Deliberately narrow, because the obvious blanket rules reject REAL prompts:
 * a structured-extraction seed prompt may itself be JSON, and prompts written
 * in the engine's own <<<SYSTEM>>>…<<<END>>> style legitimately contain
 * fences. So: JSON is rejected only when it is the operator's own edit-list
 * shape or when no parent was JSON; fences are rejected only when no parent
 * had any; instruction echoes must lead the text or constitute most of it.
 */
export function appliedPromptProblem(
  candidate: string,
  check: AppliedPromptCheck = {},
): AppliedPromptProblem | null {
  const trimmed = candidate.trim();
  const parents = (check.parents ?? []).filter((p): p is string => typeof p === 'string');
  const instructions = (check.instructions ?? []).filter((i): i is string => typeof i === 'string');

  if (trimmed === '') {
    return { code: 'empty', reason: 'is empty' };
  }

  // Scaffolding the operator template introduced: LINE-shaped fences only —
  // the template's own shapes are a line ending in <<< and a line that is only
  // >>>. (A reply keeping fence lines reproduced the template rather than
  // filling it; a parent that already uses fence lines keeps that right.)
  if (hasScaffoldLine(trimmed) && !parents.some(hasScaffoldLine)) {
    return { code: 'scaffolding', reason: 'contains the <<< >>> operator scaffolding' };
  }

  // JSON checks. Order matters (pass-19 hunter A, F2): the parent exemptions
  // are computed FIRST, because a parent that is itself edit-list-shaped JSON
  // (a labeled-taxonomy prompt: [{"label":"positive"},…]) makes JSON — even
  // edit-shaped JSON — the legitimate genre for its children; rejecting it
  // made such prompts permanently un-operable.
  const parentValues = parents.map(parseJsonValue);
  const parentIsJson = parentValues.some(v => v !== undefined && v !== null && typeof v === 'object');
  const parentIsEditShaped = parentValues.some(isEditListShape);

  // The one JSON reply that is ALWAYS an echo, whatever the parent's genre:
  // the operator's own edits payload handed back — every item's edit text
  // appears among the instructions we actually sent.
  const isActualEditsEcho = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0 && instructions.length > 0 &&
    v.every(e => e && typeof e === 'object' && typeof (e as any).edit === 'string' &&
      instructions.some(i => normalizeForEcho(i).includes(normalizeForEcho((e as any).edit))));

  const parsed = parseJsonValue(trimmed);
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    if (isActualEditsEcho(parsed)) {
      return { code: 'json', reason: 'is the operator edit list echoed back as JSON' };
    }
    if (isEditListShape(parsed) && !parentIsEditShaped) {
      return { code: 'json', reason: 'is the operator edit list echoed back as JSON' };
    }
    if (!parentIsJson) {
      return { code: 'json', reason: 'is JSON, not a prompt' };
    }
  } else if (!parentIsEditShaped) {
    // Not whole-text JSON — but the observed open-bugs #2 artifact returns
    // behind one line of prose ("Here is the new prompt:\n[{…}]"). An
    // edit-shaped array that constitutes the bulk of the reply is the payload,
    // not a prompt (pass-19 hunter A, F5).
    for (const span of balancedSpans(trimmed, '[', ']')) {
      if (span.length < trimmed.length * 0.6) continue;
      try {
        const v = JSON.parse(span);
        if (isEditListShape(v) || isActualEditsEcho(v)) {
          return { code: 'json', reason: 'is the operator edit list echoed back behind a preamble' };
        }
      } catch { /* not JSON — keep looking */ }
    }
  }

  const norm = normalizeForEcho(trimmed);
  for (const instruction of instructions) {
    // Drop the "[Category] " prefix the strategy catalog adds — the echo we
    // observed reproduced the instruction body without it.
    const rawBody = instruction.replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
    const body = normalizeForEcho(rawBody);
    if (body.length < 20) continue; // too short to be evidence either way
    // An echo is only evidence when the instruction is EDIT-language. A
    // full-rewrite edit's text IS the intended prompt, so a faithful
    // application is byte-equal to it — rejecting that burned every retry on
    // an unwinnable demand and discarded legitimate rewrites (observed live;
    // pass-19 hunter A, F1).
    if (!isEditLanguage(rawBody)) continue;
    const idx = norm.indexOf(body);
    const echoed = norm.startsWith(body) ||
      // tolerate a short preamble ("Sure! …") before the echoed instruction
      (idx !== -1 && idx <= 30 && norm.length <= body.length * 1.5);
    if (echoed) {
      return { code: 'echo', reason: 'reproduces the edit instruction instead of applying it' };
    }
  }

  for (const parent of parents) {
    // Collapsed comparison: a whitespace-reflow "mutation" is still a paid
    // no-op — same prompt, re-measured at full price under a changelog
    // claiming a change (pass-19 hunter A, F4).
    if (sameCollapsed(trimmed, parent)) {
      return { code: 'noop', reason: 'is identical to the parent prompt' };
    }
  }

  return null;
}

/**
 * Extract a JSON array from a service-model response. Models (especially
 * small/cheap ones) often wrap the array in markdown fences or surround it
 * with prose — this strips fences, then falls back to slicing from the
 * first '[' to the last ']'. Throws if no parseable array is found.
 */
export function extractJsonArray(raw: string): any[] {
  // Try the raw text FIRST. Stripping ``` unconditionally corrupted any array
  // whose strings mention code fences — and edits about fences are a common
  // category here ("Require the answer wrapped in ```json ... ``` fences"
  // became "Require the answer wrapped in  ...  fences", silently, in both the
  // changelog and the instruction re-sent to the apply step).
  const attempts: string[] = [raw.trim()];

  const defenced = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  if (defenced !== attempts[0]) attempts.push(defenced);

  for (const candidate of attempts) {
    try {
      const direct = JSON.parse(candidate);
      if (Array.isArray(direct)) return direct;
    } catch { /* try the next form */ }
  }

  // Bracket extraction. Scanning outward from the FIRST '[' to the LAST ']'
  // fails whenever prose either side contains a stray bracket
  // ("Here are the edits [see list below]: [{...}]"), so walk every balanced
  // span instead and take the first that parses as an array.
  for (const candidate of attempts) {
    for (const span of balancedArraySpans(candidate)) {
      try {
        const parsed = JSON.parse(span);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* try the next span */ }
    }
  }

  throw new Error('No JSON array found in model output');
}

/** Balanced `[...]` spans, string-aware so a bracket inside a string is ignored. */
/**
 * Every balanced `open`…`close` span in `text`, in document order,
 * string-literal aware so a brace inside a JSON string never counts.
 *
 * A flat `/\{[^{}]*\}/g` cannot match anything nested, which is why a judge
 * verdict of `{"winner":"A","scores":{"a":9,"b":4}}` parsed as unreadable and
 * was counted a tie.
 */
export function balancedSpans(text: string, open: '[' | '{', close: ']' | '}'): string[] {
  const spans: string[] = [];
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
    if (end === -1) { cursor = start + 1; continue; }
    spans.push(text.slice(start, end + 1));
    cursor = end + 1;
  }
  return spans;
}

function balancedArraySpans(text: string): string[] {
  // Longest first: the outer array is the answer, a nested one rarely is.
  return balancedSpans(text, '[', ']').sort((a, b) => b.length - a.length);
}
