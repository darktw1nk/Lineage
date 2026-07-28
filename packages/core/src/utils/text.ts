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
