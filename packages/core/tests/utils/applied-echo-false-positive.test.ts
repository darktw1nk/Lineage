import { describe, it, expect } from 'vitest';
import { appliedPromptProblem } from '../../src/utils/text.js';

/**
 * The echo gate rejects a CORRECTLY applied edit.
 *
 * The meta proposal prompt explicitly invites the model to "REWRITE any part of
 * the prompt", so models routinely return replacement TEXT in the `edit` field
 * rather than an instruction about the prompt. Applied faithfully, the new
 * prompt then equals that text — and the gate reads equality as "reproduced the
 * instruction instead of applying it".
 *
 * There is already a narrow exemption for exactly this (`readsAsReplacementText`),
 * but it excludes any text containing a parenthetical example. Few-shot examples
 * in parentheses are ordinary in real prompts, so the exemption misses the
 * common case.
 *
 * Measured across 36 benchmark runs: 266 of 383 genuine operator failures (69%)
 * were this rejection — roughly one in ten of all children, each costing a full
 * operator call and yielding a copy of its parent.
 *
 * The gate must keep rejecting the thing it was built for. Both directions are
 * asserted here, because loosening it is only safe if the exploit stays closed.
 */
const PARENT = 'Summarize the customer ticket.';
const check = (applied: string, edit: string) =>
  appliedPromptProblem(applied, { parents: [PARENT], instructions: [edit] });

describe('a faithful full-rewrite is accepted', () => {
  it('accepts clean replacement prose (already worked)', () => {
    const t = 'You are a support triage assistant. Classify each ticket by its root cause and output only the category name.';
    expect(check(t, t)).toBeNull();
  });

  it('accepts replacement prose containing a parenthetical example', () => {
    // The regression: a prompt with a few-shot example is a normal prompt.
    const t = 'You are a support triage assistant. Classify by root cause (e.g., a login failure caused by a declined payment is BILLING) and output only the category.';
    expect(check(t, t)).toBeNull();
  });

  it('accepts replacement prose containing a quoted example', () => {
    const t = 'You are a triage assistant. Output exactly one category name, such as "BILLING", with no other text or punctuation.';
    expect(check(t, t)).toBeNull();
  });

  it('accepts a long structured prompt with several examples', () => {
    const t = [
      'You are a support triage assistant.',
      'Classify each ticket into BILLING, SHIPPING, TECHNICAL or ACCOUNT.',
      'Judge by root cause (e.g., "I cannot log in" after a failed payment is BILLING).',
      'Output the category name only.',
    ].join('\n\n');
    expect(check(t, t)).toBeNull();
  });
});

describe('the exploit the gate exists to stop stays closed', () => {
  it('still rejects a strategy-catalog entry echoed as the prompt', () => {
    // Verbatim from DEFAULT_MUTATION_STRATEGIES. Adopting this AS the prompt is
    // the pass-19/20 incident: the candidate never did the work.
    const s = `Add anti-patterns ("Do not create subtasks for 'thanks', 'OK' ")`;
    expect(check(s, s)).not.toBeNull();
  });

  it('still rejects other strategy entries echoed as the prompt', () => {
    for (const s of [
      'Tighten constraints ("Output strictly RFC8259 JSON. No commentary.")',
      'Insert a thinking scaffold (e.g., "First, extract actors… Then, dedupe…")',
      'Add evaluation rubric inside the prompt ("If a task lacks an assignee, infer from speaker attribution.")',
      'Reorder sections (role → goals → constraints → output spec)',
      'Convert paragraphs to bullet checklists',
    ]) {
      expect(check(s, s), `should reject: ${s}`).not.toBeNull();
    }
  });

  it('still rejects an edit-language instruction echoed as the prompt', () => {
    const s = 'Rewrite the role statement so the assistant identifies itself as a triage bot.';
    expect(check(s, s)).not.toBeNull();
  });

  /**
   * These two open with a task verb, so the prompt-framing test alone would
   * admit them. They are what the edit-language and mostly-example guards are
   * for, and without these cases both guards can be deleted with every test
   * still passing — verified by mutation.
   */
  it('still rejects text that starts like a task but is edit advice', () => {
    const s = 'Extract the role statement from the prompt and rewrite the instruction so it is shorter.';
    expect(check(s, s)).not.toBeNull();
  });

  it('still rejects text that starts like a task but is mostly example', () => {
    const s = 'Extract fields ("name", "date", "total", "currency", "reference", "id", "status", "qty")';
    expect(check(s, s)).not.toBeNull();
  });

  it('still rejects an unchanged parent', () => {
    expect(check(PARENT, 'Add a rule about root cause.')).not.toBeNull();
  });

  it('still rejects operator scaffolding', () => {
    expect(check('<<<\nYou are a triage assistant that classifies tickets.\n>>>', 'x')).not.toBeNull();
  });

  // NOTE: an instruction shorter than 20 normalised characters is skipped by
  // design ("too short to be evidence either way"), so a tiny echo like
  // "Be concise." is accepted. That is pre-existing behaviour, not part of this
  // fix, and asserting the opposite here would have been wrong.
});
