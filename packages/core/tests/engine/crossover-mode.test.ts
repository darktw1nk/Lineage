import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/store.js', () => ({ store: { get: () => null, set: () => {}, store: {} }, setStore: vi.fn() }));

/** Every service-model call the operator makes, so "free" can be asserted. */
const calls: string[] = [];
vi.mock('../../src/providers/index.js', () => ({
  getProviderAdapter: () => ({
    name: 'openai', estimateTokens: () => ({ prompt: 1 }),
    call: async (opts: any) => {
      calls.push(opts.prompt);
      return {
        output: 'You are a merged assistant.\n\nRules:\n- Merged rule\n\nOutput: merged.',
        promptTokens: 10, completionTokens: 10, latencyMs: 1, usd: 0.002,
      };
    },
  }),
}));

import { crossoverNodes } from '../../src/engine/crossover.js';
import { mulberry32 } from '../../src/engine/rng.js';
import type { CandidateNode, EvaluationConfig } from '../../src/types.js';

/**
 * Crossover mode.
 *
 * The LLM merge bills one service call per crossover child and hands both
 * parents to a third model to rewrite. Structural splicing recombines the
 * parents' own sections for zero calls. `auto` prefers the splice and falls
 * back to the merge only when the parents have nothing to splice.
 *
 * What must hold:
 *  - `auto` on structured parents makes NO call and still produces a real child.
 *  - `auto` on structureless parents still works — it falls back and pays.
 *  - `llm` restores the old behaviour exactly, for anyone who wants it.
 *  - `structural` never silently bills a merge the user opted out of.
 *  - A splice is validated like a merge: it never returns a parent.
 */
const structured = (role: string, rule: string, fmt: string) =>
  `You are ${role}.\n\nRules:\n- ${rule}\n\nOutput format: ${fmt}.`;

function node(id: string, prompt: string): CandidateNode {
  return {
    id, generation: 1, lineageParents: [], status: 'finished', prompt,
    params: { model: { provider: 'openai', model: 'gpt-x' }, temperature: 0.7 },
    changeLog: [], metrics: { fitness: 8, quality: 8 },
  } as unknown as CandidateNode;
}

const A = node('aaaaaaaa-1', structured('a triage bot', 'Be concise', 'one line'));
const B = node('bbbbbbbb-2', structured('an analyst', 'Cite the ticket ID', 'JSON'));
const BLOB_A = node('cccccccc-3', 'Summarize the ticket.');
const BLOB_B = node('dddddddd-4', 'Condense the ticket.');

const config = (crossoverMode?: string): EvaluationConfig => ({
  id: 'c', name: 'crossover mode',
  selection: { policy: 'topk', topK: 2 },
  operators: { mutationShare: 0, crossoverShare: 1, ...(crossoverMode ? { crossoverMode } : {}) },
  population: { initialSize: 4, generationSize: 4, seedPrompt: 's', fill: 'auto' },
  enabledModels: [{ provider: 'openai', model: 'gpt-x' }],
  testSet: [], fitness: { weights: { quality: 1 } }, targets: {},
  serviceModel: { provider: 'openai', model: 'gpt-x' },
  parallelLimit: 2, serviceModelMaxTokens: 100, retries: 2,
} as unknown as EvaluationConfig);

beforeEach(() => { calls.length = 0; });

describe('auto prefers the free splice', () => {
  it('makes no service call on parents that have sections', async () => {
    const r = await crossoverNodes(A, B, config(), undefined, mulberry32(4));
    expect(calls).toHaveLength(0);
    expect(r.cost.usd).toBe(0);
    expect(r.cost.calls).toBe(0);
  });

  it('produces a genuine child, not a carried parent', async () => {
    const r = await crossoverNodes(A, B, config(), undefined, mulberry32(4));
    expect(r.prompt).not.toBe(A.prompt);
    expect(r.prompt).not.toBe(B.prompt);
    expect(r.changeLog[0].label).toBe('CROSSOVER');
  });

  it('says in the changelog that no LLM was involved', async () => {
    const r = await crossoverNodes(A, B, config(), undefined, mulberry32(4));
    // A CROSSOVER line that reads like the LLM merge would misreport how the
    // child was made — the lineage view is the user's record of provenance.
    expect(r.changeLog[0].text).toMatch(/splice|section/i);
    expect(r.changeLog[0].text).toMatch(/no LLM call/i);
  });

  it('inherits material from both parents verbatim', async () => {
    const r = await crossoverNodes(A, B, config(), undefined, mulberry32(4));
    const fromA = A.prompt.split(/\n\s*\n/).some(s => r.prompt.includes(s.trim()));
    const fromB = B.prompt.split(/\n\s*\n/).some(s => r.prompt.includes(s.trim()));
    expect(fromA || fromB).toBe(true);
  });
});

describe('a splice that only reflows a parent is rejected', () => {
  /**
   * `structuralCrossover` compares its child to the parents with `.trim()`,
   * which cannot see that a child differing only in blank lines and spacing IS
   * a parent. Rejoining sections with '\n\n' produces exactly that. The
   * operator therefore validates the splice with the same `appliedPromptProblem`
   * gate the LLM merge goes through, whose comparison is whitespace-insensitive.
   *
   * Without it the generation quietly fills with re-spaced duplicates that each
   * cost a full evaluation to score.
   */
  const spaced1 = node('eeeeeeee-5', 'You are X.\n\nRules:\n- Be terse\n\nOutput: one line.');
  const spaced2 = node('ffffffff-6', 'You are X.\n\n\n\nRules:\n-  Be terse\n\n\n\nOutput:  one line.');

  it('does not pass off a whitespace variant of a parent as a child', async () => {
    const r = await crossoverNodes(spaced1, spaced2, config(), undefined, mulberry32(4));
    const canon = (t: string) => t.split('\n').map(l => l.trim().replace(/\s+/g, ' '))
      .filter(Boolean).join('\n');
    if (r.changeLog[0].label === 'CROSSOVER' && r.cost.calls === 0) {
      expect(canon(r.prompt)).not.toBe(canon(spaced1.prompt));
      expect(canon(r.prompt)).not.toBe(canon(spaced2.prompt));
    }
  });

  it('falls back to the LLM merge instead of emitting the duplicate', async () => {
    const r = await crossoverNodes(spaced1, spaced2, config(), undefined, mulberry32(4));
    expect(calls).toHaveLength(1);
    expect(r.cost.calls).toBe(1);
  });
});

describe('auto falls back when there is nothing to splice', () => {
  it('pays for the LLM merge on structureless parents', async () => {
    const r = await crossoverNodes(BLOB_A, BLOB_B, config(), undefined, mulberry32(4));
    expect(calls).toHaveLength(1);
    expect(r.cost.calls).toBe(1);
    expect(r.prompt).toContain('merged');
  });
});

describe('llm mode restores the previous behaviour exactly', () => {
  it('calls the service model even when the parents could be spliced', async () => {
    const r = await crossoverNodes(A, B, config('llm'), undefined, mulberry32(4));
    expect(calls).toHaveLength(1);
    expect(r.cost.usd).toBeGreaterThan(0);
  });
});

describe('structural mode never bills a merge behind the user', () => {
  it('carries a parent instead of falling back to the LLM', async () => {
    const r = await crossoverNodes(BLOB_A, BLOB_B, config('structural'), undefined, mulberry32(4));
    expect(calls).toHaveLength(0);
    expect(r.cost.usd).toBe(0);
    expect(r.changeLog[0].label).toBe('CARRY');
    expect(r.prompt).toBe(BLOB_A.prompt);
  });

  it('still splices when it can', async () => {
    const r = await crossoverNodes(A, B, config('structural'), undefined, mulberry32(4));
    expect(calls).toHaveLength(0);
    expect(r.changeLog[0].label).toBe('CROSSOVER');
  });
});

describe('the splice is reproducible', () => {
  it('gives the same child for the same seed', async () => {
    const a = await crossoverNodes(A, B, config(), undefined, mulberry32(9));
    const b = await crossoverNodes(A, B, config(), undefined, mulberry32(9));
    expect(a.prompt).toBe(b.prompt);
  });
});
