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
