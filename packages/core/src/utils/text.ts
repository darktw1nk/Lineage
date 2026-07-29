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
  while (isSingleWrapper(result)) {
    const match = result.match(/^<<<\s*([\s\S]*)\s*>>>$/);
    if (!match) break;
    result = match[1].trim();
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
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
  } catch {
    // Fall through to bracket extraction
  }
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const sliced = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(sliced)) return sliced;
    } catch {
      // Fall through to the error below
    }
  }
  throw new Error('No JSON array found in model output');
}
