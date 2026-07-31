/**
 * Example Lineage operator plugin (LLM-free, deterministic).
 * Rotates double-newline-separated prompt sections: the first section moves
 * to the end. Useful as a template for your own operators.
 */
export default {
  name: 'section-shuffle',
  version: '1.0.0',
  operators: [{
    name: 'section-shuffle',
    label: 'Section Shuffle',
    description: 'Rotates prompt sections to escape ordering-based local optima',
    parents: 1,
    async apply({ parent }) {
      const sections = parent.prompt.split(/\n\n+/);
      const rotated = sections.length > 1 ? [...sections.slice(1), sections[0]] : sections;
      return {
        prompt: rotated.join('\n\n'),
        changeLog: [{ label: 'SECTION-SHUFFLE', text: `Rotated ${sections.length} sections` }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  }],
};
