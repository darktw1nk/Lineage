/**
 * Strip meta-prompt wrapper delimiters (<<< / >>>) that service models
 * sometimes echo back around a rewritten prompt. Unwraps repeatedly so
 * nested wrappers from compounding operator steps are fully removed.
 * Conservative: only strips when the text both starts with <<< and ends
 * with >>>.
 */
export function stripPromptDelimiters(text: string): string {
  let result = text.trim();
  for (;;) {
    const match = result.match(/^<<<\s*([\s\S]*?)\s*>>>$/);
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
