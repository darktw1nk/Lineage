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
 * Invisible characters that could HIDE a delimiter. Deliberately excludes
 * U+200C/U+200D (ZWNJ/ZWJ): those are content, not formatting — stripping them
 * broke emoji families into separate emoji and mangled Indic conjuncts.
 * Applied ONLY to a line that is already delimiter-shaped (see below).
 */
const HIDING_CHARS = /[­​‎‏‪-‮⁠-⁤⁪-⁯﻿]/g;

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
export function sanitizeForJudge(text: string): string {
  const clipped = text.length > MAX_JUDGED_TEXT
    ? `${text.slice(0, MAX_JUDGED_TEXT)}\n…[truncated ${text.length - MAX_JUDGED_TEXT} characters]`
    : text;

  return clipped.split(/\r?\n/).map(line => {
    const bare = line.replace(HIDING_CHARS, '');
    // A line of NOTHING BUT `>` closes the block (>>>, >>>>, …); a line ending
    // in 3+ `<` opens a forged one, which is the shape of the template's own
    // `LABEL: <<<`. Anything else cannot escape the block.
    const closes = /^>{3,}$/.test(bare.trim());
    const opens = /<{3,}$/.test(bare.trimEnd());
    if (!closes && !opens) return line; // untouched — the overwhelming majority
    // Space-separated so the JUDGE (which cannot see zero-width characters)
    // genuinely reads it as something other than a delimiter.
    return bare.replace(/>{3,}/g, m => m.split('').join(' '))
               .replace(/<{3,}/g, m => m.split('').join(' '));
  }).join('\n');
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
