/**
 * What each crossover method will actually do, and what it will cost.
 *
 * The cost difference is the part users need in front of them: the LLM merge
 * bills a service call for every crossover child, splicing bills none. A
 * dropdown that only named the modes would hide the one fact that decides the
 * choice.
 */
export type CrossoverMode = 'auto' | 'structural' | 'llm';

export function crossoverModeHint(mode: CrossoverMode): string {
  switch (mode) {
    case 'structural':
      return 'Children are assembled from the parents\' own sections — no LLM calls, so crossover is free. Parents with no section structure are carried unchanged instead.';
    case 'llm':
      return 'The service model rewrites both parents into a merge. One billed call per crossover child, and a parent\'s wording survives only if that model keeps it.';
    case 'auto':
    default:
      return 'Splices the parents\' sections for free when they have structure, and pays for an LLM merge only when they do not.';
  }
}
