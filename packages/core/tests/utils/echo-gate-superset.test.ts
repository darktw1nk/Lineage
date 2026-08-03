import { describe, it, expect } from 'vitest';
import { appliedPromptProblem } from '../../src/utils/text.js';

/**
 * The exemption must only ever GROW.
 *
 * The first attempt at this fix widened the gate for prompts carrying an
 * example and simultaneously narrowed it by demanding a role or task verb at
 * the start. Real evolved prompts often have neither, so legitimate children
 * were rejected — measured end to end, waste went from 13% to 40%. The unit
 * tests were green throughout, because they were written from cases I imagined
 * rather than prompts real runs produce.
 *
 * The rule is now a strict superset: text with no example marker takes the
 * original path unchanged, so a regression is impossible by construction.
 * Checked against 5,964 distinct texts from 36 benchmark runs — 0 regressions,
 * 192 newly accepted.
 *
 * The prompts below are VERBATIM from those runs. Each was rejected as "the
 * applied prompt reproduces the edit instruction instead of applying it",
 * costing a full operator call and yielding a copy of its parent.
 */
const PARENT = 'Summarize the customer ticket.';
const check = (t: string) => appliedPromptProblem(t, { parents: [PARENT], instructions: [t] });

describe('real prompts that the gate used to reject as echoes', () => {
  const REAL = [
    "Extract the relevant information from the customer ticket and format it as key-value pairs, separated by '|'. The keys to extract are: order, issue, request.",
    'Extract the order number, the issue described, and the customer request from the ticket. Format the output as: order=<order_number> | issue=<issue> | request=<request>',
    'Summarize the meeting transcript. The summary should be concise, focusing on key decisions, action items, and significant outcomes (e.g., "approved the budget").',
  ];

  it.each(REAL)('accepts a faithful application: %s', (prompt) => {
    expect(check(prompt)).toBeNull();
  });
});

/**
 * The superset property itself. If any of these stops being accepted, the rule
 * has narrowed and children are being discarded again — which is exactly the
 * regression this file exists to prevent.
 */
describe('text without an example marker keeps the original behaviour', () => {
  const NO_MARKER = [
    'Extract key information from the customer ticket and format it concisely.',
    'Focus on the order number, the issue type and what the customer is asking for.',
    'Return a single line containing the category name and nothing else at all.',
    'You are a triage assistant. Classify each incoming support ticket accurately.',
  ];

  it.each(NO_MARKER)('accepts: %s', (prompt) => {
    expect(check(prompt)).toBeNull();
  });
});

describe('the exploit stays closed', () => {
  it.each([
    `Add anti-patterns ("Do not create subtasks for 'thanks', 'OK' ")`,
    'Tighten constraints ("Output strictly RFC8259 JSON. No commentary.")',
    'Use markdown headers to separate the response into sections (e.g., ## Answer)',
    'Rewrite the role statement so the assistant identifies itself as a triage bot.',
  ])('still rejects: %s', (text) => {
    expect(check(text)).not.toBeNull();
  });
});
