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

  describe('pass-19 fixes: the gate must not reject legitimate work', () => {
    it('accepts a FAITHFUL application of a full-rewrite edit (observed live)', () => {
      // The edit text IS the intended replacement prompt; a faithful
      // application is byte-equal to it. Pass 18 rejected this as an echo,
      // burned every retry on an unwinnable demand, and discarded the rewrite.
      const edit = 'Extract key information from the customer ticket and format it concisely.';
      expect(appliedPromptProblem(edit, {
        parents: ['Summarize the customer ticket.'],
        instructions: [`[REWRITE] ${edit}`],
      })).toBeNull();
    });

    it('still rejects an echo of EDIT-language (an imperative about the prompt)', () => {
      const p = appliedPromptProblem(
        'Rewrite the role/identity statement to better align with the actual task requirements',
        {
          parents: ['Summarize the customer ticket.'],
          instructions: ['[Rewrite] Rewrite the role/identity statement to better align with the actual task requirements'],
        },
      );
      expect(p?.code).toBe('echo');
    });

    it('lets a labeled-taxonomy JSON parent be operated on', () => {
      // Pass 18 classified ANY array of {label} objects as the operator edit
      // list, before the JSON-parent exemption — such prompts could never be
      // mutated or crossed over again.
      const taxonomy = '[{"label":"positive"},{"label":"negative"}]';
      expect(appliedPromptProblem(
        '[{"label":"positive"},{"label":"negative"},{"label":"neutral"}]',
        { parents: [taxonomy] },
      )).toBeNull();
      // And a byte-identical result is a NOOP for it, not "json".
      expect(appliedPromptProblem(taxonomy, { parents: [taxonomy] })?.code).toBe('noop');
    });

    it('still rejects the ACTUAL edits payload echoed back, taxonomy parent or not', () => {
      const p = appliedPromptProblem(
        '[{"label":"MUTATION","edit":"add a neutral category to the label set"}]',
        {
          parents: ['[{"label":"positive"},{"label":"negative"}]'],
          instructions: ['add a neutral category to the label set'],
        },
      );
      expect(p?.code).toBe('json');
    });

    it('rejects the edit list hidden behind one line of prose', () => {
      const p = appliedPromptProblem(
        'Here is the new prompt:\n[{"label":"MUTATION","edit":"Tighten the constraints on the output format"}]',
        { parents: ['Answer the question.'] },
      );
      expect(p?.code).toBe('json');
    });

    it('accepts a bash herestring — <<< mid-line is not scaffolding', () => {
      expect(appliedPromptProblem(
        'Answer the question. Example: `tr a-z A-Z <<< "hello"` prints HELLO.',
        { parents: ['Answer the question.'] },
      )).toBeNull();
    });

    it('catches an echo smuggled past \\s with zero-width characters', () => {
      const body = 'Rewrite the role/identity statement to better align with the task';
      const smuggled = body.slice(0, 10) + '​' + body.slice(10);
      expect(appliedPromptProblem(smuggled, {
        parents: ['Answer.'],
        instructions: [`[Rewrite] ${body}`],
      })?.code).toBe('echo');
    });

    it('treats a whitespace-reflow as the no-op it is', () => {
      expect(appliedPromptProblem(
        'Answer   the question.',
        { parents: ['Answer the question.'] },
      )?.code).toBe('noop');
    });
  });

  describe('pass-20 fixes: the exemptions must not reopen the channel', () => {
    const PARENT = 'Summarize the customer ticket.';

    it('rejects verbatim echoes of built-in strategies the verb catalog missed', () => {
      // Pass 19 gated echo rejection on an English verb+noun pattern; six of
      // the seventeen built-in strategies failed it and their echoes were
      // ADOPTED as candidate prompts (pass 20, F1).
      for (const strategy of [
        '[Structure] Insert a thinking scaffold (e.g., "First, extract actors… Then, dedupe…")',
        '[Regularizers] Force field-by-field validation hints (e.g., JSON schema embedded)',
        '[Content] Introduce domain terms/ontologies',
      ]) {
        const body = strategy.replace(/^\s*\[[^\]]+\]\s*/, '');
        expect(appliedPromptProblem(body, { parents: [PARENT], instructions: [strategy] })?.code,
          `should reject echo of: ${strategy}`).toBe('echo');
      }
    });

    it('rejects an echo of an unlisted-verb instruction too', () => {
      const edit = 'Use markdown headers to separate the response into sections (e.g., ## Answer)';
      expect(appliedPromptProblem(edit, { parents: [PARENT], instructions: [edit] })?.code).toBe('echo');
    });

    it('still rejects the ACTUAL edits payload behind a preamble for an edit-shaped parent (F2)', () => {
      const taxonomy = '[{"label":"positive"},{"label":"negative"}]';
      const p = appliedPromptProblem(
        'Here is the new prompt:\n[{"label":"MUTATION","edit":"[Structure] Reorder sections for clarity"}]',
        { parents: [taxonomy], instructions: ['[Structure] Reorder sections for clarity'] },
      );
      expect(p?.code).toBe('json');
    });

    it('catches the payload emitted twice with no prose (F3b)', () => {
      const payload = '[{"label":"MUTATION","edit":"Tighten all the output constraints"}]';
      const p = appliedPromptProblem(`${payload}\n\n${payload}`, { parents: [PARENT] });
      expect(p?.code).toBe('json');
    });

    it('catches the ACTUAL payload however much prose pads it (F3a)', () => {
      const pad = 'Certainly! I considered the request carefully and here is my response, with reasoning. '.repeat(4);
      const p = appliedPromptProblem(
        `${pad}\n[{"label":"MUTATION","edit":"Tighten all the output constraints"}]`,
        { parents: [PARENT], instructions: ['Tighten all the output constraints'] },
      );
      expect(p?.code).toBe('json');
    });

    it('catches scaffolding on exotic line terminators and one-line folds (F4)', () => {
      // CR-only line break
      expect(appliedPromptProblem('Original: <<<\rYou are helpful.\r>>>', { parents: [PARENT] })?.code)
        .toBe('scaffolding');
      // The whole template folded onto ONE line
      expect(appliedPromptProblem(
        'Original: <<< Summarize the customer ticket. >>> Edits: [] Produce the NEW prompt ONLY.',
        { parents: [PARENT] },
      )?.code).toBe('scaffolding');
      // A herestring (only <<<, no >>>) is still fine
      expect(appliedPromptProblem(
        'Answer briefly. Example: `tr a-z A-Z <<< "hello"` prints HELLO.',
        { parents: [PARENT] },
      )).toBeNull();
    });

    it('a hiding-character-only "change" is the no-op it is (F5)', () => {
      const smuggled = PARENT.slice(0, 9) + '​' + PARENT.slice(9);
      expect(appliedPromptProblem(smuggled, { parents: [PARENT] })?.code).toBe('noop');
    });

    it('a newline-structure-only edit is a REAL change (F6)', () => {
      const listified = 'Summarize the customer ticket.\n- name the issue\n- name the ask';
      expect(appliedPromptProblem(listified, { parents: [PARENT + ' Name the issue and name the ask.'] })).toBeNull();
      // Breaking one sentence across lines without changing words: still a change.
      expect(appliedPromptProblem('Summarize\nthe customer ticket.', { parents: [PARENT] })).toBeNull();
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
