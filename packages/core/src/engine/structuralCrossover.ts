/**
 * Section-level (and multi-parent) recombination.
 *
 * The LLM crossover asks a service model to "merge the best parts of A and B".
 * That is not recombination — it is a third model rewriting both parents from
 * scratch. It costs a call per child, and whatever made a parent good survives
 * only if the merging model happens to notice it and keep the wording; the
 * usual outcome is a blend blander than either parent.
 *
 * Genetic crossover works because building blocks are inherited VERBATIM and
 * recombined. Prompts have visible building blocks — the role line, the rules
 * list, the format contract, the examples — separated by blank lines. Splicing
 * at those boundaries is real recombination: the child is made of its parents'
 * material rather than a paraphrase of it, the combinatorial space of that
 * material actually gets explored, and it costs nothing.
 *
 * Returns null whenever splicing would be dishonest — no structure to splice,
 * identical parents, or every draw reproducing a parent — so the caller can
 * fall back to the LLM merge instead of billing a no-op child.
 */

/** A prompt's building blocks, or null if it has none worth splicing. */
export function splitSections(prompt: string): string[] | null {
  if (!prompt || !prompt.trim()) return null;

  // Blank lines are the strongest signal an author gives about structure.
  let sections = prompt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

  if (sections.length < 2) {
    // No blank lines, but consecutive directive lines are still blocks.
    const lines = prompt.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) sections = lines;
  }

  if (sections.length < 2) {
    // Still one block — and this is the common case, not the exception.
    // Measured on a real run: half the evolved prompts were a single
    // paragraph with no newline anywhere, and because both parents must be
    // splittable that left the splice firing on roughly a quarter of pairs.
    // A prompt like "Summarize the ticket. Include the order number. Never
    // speculate." has three building blocks; the boundary is just a full stop
    // rather than a blank line.
    const sentences = coalesce(prompt.trim().split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean));
    if (sentences.length >= 2) sections = sentences;
  }

  return sections.length >= 2 ? sections : null;
}

/**
 * Merge fragments too short to be a building block into the preceding one, so
 * "Do it. Now." stays whole instead of becoming two meaningless slots that
 * recombination can shuffle into nonsense.
 */
function coalesce(parts: string[], minChars = 20): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && part.length < minChars) out[out.length - 1] += ' ' + part;
    else out.push(part);
  }
  // Only out[0] can be shorter than minChars: everything pushed afterwards had
  // to clear the threshold to be pushed at all, and blocks only ever grow. So
  // a short block can only survive as a lone first element, which fails the
  // `>= 2` check upstream anyway. (A trailing-stub fold used to sit here; it
  // was unreachable for exactly this reason, and no mutation of it could fail
  // a test.)
  return out;
}

export interface StructuralChild {
  prompt: string;
  /** Which parent each emitted section came from, by index into `parents`. */
  fromParent: number[];
}

/**
 * Uniform crossover over aligned sections.
 *
 * Sections are aligned by position: parents in this engine descend from a
 * common seed, so position N tends to hold the same KIND of instruction in
 * every parent (role, then rules, then format). Picking one parent's version
 * of each slot swaps whole functional blocks rather than shredding them.
 */
export function structuralCrossover(
  parents: readonly string[],
  rng: () => number,
): StructuralChild | null {
  // Documentary, not load-bearing: the identical-parents check below already
  // returns null for 0 and 1 parents (`[].every` is true, and a lone parent is
  // trivially equal to itself). Deleting this line changes no behaviour and no
  // test — an equivalent mutant, kept because it states the precondition where
  // a reader looks for it.
  if (parents.length < 2) return null;

  const split = parents.map(splitSections);
  // One structureless parent means its material cannot be spliced at all, and
  // a child drawn only from the others is not a crossover of these parents.
  if (split.some(s => s === null)) return null;
  const sections = split as string[][];

  // Identical parents cannot produce a child that differs from them, whatever
  // the draw. Say so instead of returning a copy.
  if (parents.every(p => p === parents[0])) return null;

  const slots = Math.max(...sections.map(s => s.length));

  // A few draws, because uniform crossover can legitimately reproduce a parent
  // (all slots drawn from the same one) and that child would be a paid no-op.
  for (let attempt = 0; attempt < 12; attempt++) {
    const chosen: string[] = [];
    const fromParent: number[] = [];
    const seen = new Set<string>();

    for (let slot = 0; slot < slots; slot++) {
      const available = sections
        .map((s, parentIndex) => ({ text: s[slot], parentIndex }))
        .filter(c => c.text !== undefined);
      if (!available.length) continue;

      const pick = available[Math.floor(rng() * available.length) % available.length];

      // Parents sharing ancestry share sections. Emitting both copies would
      // duplicate an instruction — usually a rule the model then sees twice.
      const key = pick.text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      chosen.push(pick.text);
      fromParent.push(pick.parentIndex);
    }

    if (!chosen.length) continue;
    const prompt = chosen.join('\n\n');
    if (parents.some(p => p.trim() === prompt)) continue;
    return { prompt, fromParent };
  }

  return null;
}
