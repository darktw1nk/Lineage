import { describe, it, expect } from 'vitest';
import { appliedPromptProblem } from '../../src/utils/text.js';

/**
 * Bug 1 & 2 of docs/analysis/2026-07-31-open-bugs.md, observed in a real run:
 *
 *  - node1's prompt came back byte-identical to the seed, with a changelog
 *    claiming two applied mutations — a paid no-op adopted as a new candidate.
 *  - node3's prompt was the mutation INSTRUCTION echoed back ("Rewrite the
 *    role/identity statement to better align with…"), and in the plugin run
 *    the proposal JSON itself became the champion prompt.
 *
 * appliedPromptProblem is the gate every operator's applied text must pass
 * before it is adopted as a candidate prompt.
 *
 * The checks must NOT reject legitimate prompts: a prompt may BE a JSON object
 * (structured-extraction seeds are), and may contain <<< >>> fences (the
 * engine's own <<<SYSTEM>>>…<<<END>>> prompt style) — so the validator rejects
 * the operator's own artefacts, not those surface shapes per se.
 */
describe('appliedPromptProblem', () => {
  const PARENT = 'You are a helpful assistant. Answer the question.';

  it('accepts an ordinary rewritten prompt', () => {
    expect(appliedPromptProblem(
      'You are a precise assistant.\n- Answer briefly.\n- Cite sources.',
      { parents: [PARENT] },
    )).toBeNull();
  });

  it('rejects an empty or whitespace-only result', () => {
    expect(appliedPromptProblem('', { parents: [PARENT] })?.code).toBe('empty');
    expect(appliedPromptProblem('   \n ', { parents: [PARENT] })?.code).toBe('empty');
  });

  describe('no-op results (bug 1)', () => {
    it('rejects a result identical to the parent', () => {
      const p = appliedPromptProblem(PARENT, { parents: [PARENT] });
      expect(p?.code).toBe('noop');
    });

    it('rejects modulo leading/trailing whitespace', () => {
      expect(appliedPromptProblem(`\n  ${PARENT}  \n`, { parents: [PARENT] })?.code).toBe('noop');
    });

    it('rejects a crossover result identical to EITHER parent', () => {
      expect(appliedPromptProblem('B prompt', { parents: ['A prompt', 'B prompt'] })?.code).toBe('noop');
    });

    it('accepts a genuine edit, however small', () => {
      expect(appliedPromptProblem(`${PARENT} Be terse.`, { parents: [PARENT] })).toBeNull();
    });
  });

  describe('operator JSON adopted as a prompt (bug 2)', () => {
    it('rejects the edit-proposal JSON echoed back', () => {
      const p = appliedPromptProblem(
        '[{"label":"ADD","edit":"append the token ALPHA"}]',
        { parents: [PARENT] },
      );
      expect(p?.code).toBe('json');
    });

    it('rejects the edit list even when fenced in markdown', () => {
      const p = appliedPromptProblem(
        '```json\n[{"label":"MUTATION","edit":"Tighten constraints"}]\n```',
        { parents: [PARENT] },
      );
      expect(p?.code).toBe('json');
    });

    it('rejects arbitrary JSON when the parent is not a JSON prompt', () => {
      const p = appliedPromptProblem('{"role":"system","content":"hi"}', { parents: [PARENT] });
      expect(p?.code).toBe('json');
    });

    it('accepts a JSON candidate when the parent prompt is itself JSON', () => {
      const jsonParent = '{"name":"Bob","email":"b@x.co"}';
      expect(appliedPromptProblem(
        '{"name":"Bob","email":"b@x.co","phone":"+47"}',
        { parents: [jsonParent] },
      )).toBeNull();
    });

    it('still rejects the edit list when the parent is JSON', () => {
      const jsonParent = '{"name":"Bob"}';
      const p = appliedPromptProblem(
        '[{"label":"MUTATION","edit":"add a phone field"}]',
        { parents: [jsonParent] },
      );
      expect(p?.code).toBe('json');
    });
  });

  describe('instruction echoes (bug 2, observed as node3)', () => {
    const INSTRUCTION = '[Rewrite] Rewrite the role/identity statement to better align with the actual task requirements';

    it('rejects a result that STARTS with the instruction text', () => {
      const p = appliedPromptProblem(
        'Rewrite the role/identity statement to better align with the actual task requirements: You are…',
        { parents: [PARENT], instructions: [INSTRUCTION] },
      );
      expect(p?.code).toBe('echo');
    });

    it('rejects a result that is essentially just the instruction', () => {
      const p = appliedPromptProblem(
        'Sure! Rewrite the role/identity statement to better align with the actual task requirements.',
        { parents: [PARENT], instructions: [INSTRUCTION] },
      );
      expect(p?.code).toBe('echo');
    });

    it('accepts a long prompt that merely quotes a short instruction line', () => {
      // A legitimate application: the edit said what line to add, and the
      // rewritten prompt contains that line among much else.
      const applied =
        `${PARENT}\nRules:\n- Output strictly RFC8259 JSON. No commentary.\n` +
        '- If a task lacks an assignee, infer from speaker attribution.\n- Keep answers under 100 words.';
      expect(appliedPromptProblem(applied, {
        parents: [PARENT],
        instructions: ['[Content] Output strictly RFC8259 JSON. No commentary.'],
      })).toBeNull();
    });

    it('ignores instructions too short to be meaningful evidence', () => {
      expect(appliedPromptProblem('Fix something. Then answer well, with care and выдержка.', {
        parents: [PARENT], instructions: ['Fix something'],
      })).toBeNull();
    });
  });

  describe('template scaffolding (bug 2)', () => {
    it('rejects a result that introduces the <<< >>> fences the parent never had', () => {
      const p = appliedPromptProblem(
        'Original: <<<\nYou are a helpful assistant.\n>>>\nProduce the NEW prompt ONLY.',
        { parents: [PARENT] },
      );
      expect(p?.code).toBe('scaffolding');
    });

    it('accepts fences when the parent prompt already uses that style', () => {
      const fencedParent = '<<<SYSTEM>>>\nYou are terse.\n<<<END>>>';
      expect(appliedPromptProblem(
        '<<<SYSTEM>>>\nYou are terse and precise.\n<<<END>>>',
        { parents: [fencedParent] },
      )).toBeNull();
    });
  });
});
