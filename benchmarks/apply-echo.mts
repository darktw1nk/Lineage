/**
 * How often does the meta-prompt APPLY step echo the edit instead of applying it?
 *
 * Measured across 36 ablation runs: 266 of 383 genuine operator failures (69%)
 * were "the applied prompt reproduces the edit instruction instead of applying
 * it". At ~10% of all children that is systematic, not bad luck — and a
 * systematic model failure usually means the template invites it.
 *
 * This measures the current template against candidate replacements on the same
 * (parent, edit) pairs, scoring with the engine's OWN validator so a "pass" here
 * means the engine would have accepted the child. No template change ships
 * without a measured before/after.
 *
 *   npx tsx --tsconfig packages/cli/tsconfig.json benchmarks/apply-echo.mts [trials]
 */
import { fillTemplate, sanitizeForJudge, appliedPromptProblem, stripPromptDelimiters } from '../packages/core/src/utils/text.js';
import { getProviderAdapter } from '../packages/core/src/providers/index.js';
import { setStore } from '../packages/core/src/store.js';

const TRIALS = Number(process.argv[2] ?? 8);
const [MP, MM] = (process.argv[3] ?? 'openai/gpt-5-nano').split('/');
const MODEL = { provider: MP, model: MM };

// Keys come from the environment; the engine's store is not needed here.
setStore({
  get: (k: string) => (k === 'apiKey.openai' ? process.env.OPENAI_API_KEY
    : k === 'apiKey.gemini' ? process.env.GEMINI_API_KEY : undefined),
  set: () => {},
  store: {},
} as any);

/** Realistic (parent, edit) pairs, in the shape the operator actually produces. */
const CASES = [
  // REAL strategies from DEFAULT_MUTATION_STRATEGIES, which is what the proposal
  // step actually emits. They embed literal quoted example text — and that text
  // legitimately ends up in the applied prompt.
  {
    parent: 'Summarize the customer ticket.',
    edits: [{ label: 'MUTATION', edit: 'Add evaluation rubric inside the prompt ("If a task lacks an assignee, infer from speaker attribution.")' }],
  },
  {
    parent: 'Summarize the customer ticket.',
    edits: [{ label: 'MUTATION', edit: `Add anti-patterns ("Do not create subtasks for 'thanks', 'OK' ")` }],
  },
  {
    parent: 'Extract the details from the message.',
    edits: [{ label: 'MUTATION', edit: 'Tighten constraints ("Output strictly RFC8259 JSON. No commentary.")' }],
  },
  {
    parent: 'Summarize the meeting transcript.',
    edits: [{ label: 'MUTATION', edit: 'Insert a thinking scaffold (e.g., "First, extract actors… Then, dedupe…")' }],
  },
];

const TEMPLATES: Record<string, string> = {
  // Exactly what ships today.
  current: `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${parentPrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`,

  // Fence the edits so their boundary is unambiguous, state the failure mode
  // explicitly, and put the ORIGINAL last so the thing to transform is the most
  // recent context rather than the instruction.
  fenced: `SYSTEM: You rewrite a prompt by applying edit instructions to it. You output the rewritten prompt and nothing else.

USER: Apply these edits:
EDITS: <<<
\${edits}
>>>

To this prompt:
PROMPT: <<<
\${parentPrompt}
>>>

Return the full rewritten PROMPT — every part of it, with the edits applied.
Do NOT return the edits, a description of your changes, or any commentary.
The reply must be usable as a prompt on its own.`,
};

async function run(templateName: string, tmpl: string) {
  const adapter = getProviderAdapter(MODEL.provider);
  let ok = 0, echoed = 0, other = 0;
  const failures: string[] = [];

  for (let t = 0; t < TRIALS; t++) {
    const c = CASES[t % CASES.length];
    const prompt = fillTemplate(tmpl, {
      parentPrompt: sanitizeForJudge(c.parent),
      edits: JSON.stringify(c.edits),
    });
    let out = '';
    try {
      const r = await adapter.call({
        model: MODEL.model, prompt, temperature: 0.7, maxTokens: 16000,
      } as any);
      out = stripPromptDelimiters(r.output ?? '');
    } catch (err) {
      other++; failures.push(`call failed: ${String(err).slice(0, 60)}`); continue;
    }
    // The ENGINE's validator, so a pass here is a pass in a real run.
    const problem = appliedPromptProblem(out, {
      parents: [c.parent, sanitizeForJudge(c.parent)],
      instructions: c.edits.map(e => e.edit),
    });
    if (!problem) { ok++; continue; }
    if (problem.code === 'echo' || /reproduces the edit/i.test(problem.reason)) {
      echoed++; failures.push(`ECHO: ${out.slice(0, 70)}`);
    } else {
      other++; failures.push(`${problem.code}: ${problem.reason.slice(0, 60)}`);
    }
  }
  const pct = (n: number) => `${((100 * n) / TRIALS).toFixed(0)}%`;
  console.log(`${templateName.padEnd(9)}  accepted ${String(ok).padStart(2)}/${TRIALS} (${pct(ok)})   echoed ${String(echoed).padStart(2)} (${pct(echoed)})   other ${other}`);
  for (const f of failures.slice(0, 2)) console.log(`             ${f}`);
  return { ok, echoed, other };
}

console.log(`apply-step echo rate, ${TRIALS} trials per template, model ${MODEL.provider}/${MODEL.model}\n`);
const results: Record<string, any> = {};
for (const [name, tmpl] of Object.entries(TEMPLATES)) {
  results[name] = await run(name, tmpl);
}
console.log('\nAccepted-child rate is the number that matters: a rejected child costs a full');
console.log('operator call and yields a copy of its parent.');
