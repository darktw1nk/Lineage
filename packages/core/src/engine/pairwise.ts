/**
 * Pairwise playoff: round-robin comparison of top contenders' STORED outputs,
 * judged by the service model in BOTH orders per pair to cancel position bias.
 * Produces a Copeland ranking used to sharpen selection/elite/champion.
 * Absolute fitness is not modified.
 */
import type { CandidateNode, TestCase, EvaluationConfig, UUID } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';
import { fillTemplate, sanitizeForJudge, balancedSpans } from '../utils/text.js';

export interface PlayoffOptions {
  contenders: CandidateNode[];
  tests: TestCase[];
  config: EvaluationConfig;
  accrue: (usd: number, promptTokens: number, completionTokens: number) => void;
  shouldAbort?: () => boolean;
}

export interface PlayoffResult {
  ranking: UUID[];
  points: Record<UUID, number>;
  matches: number;
}

// Anti-verbosity rules are load-bearing: A/B testing (2026-07-28) showed pairwise
// judges systematically prefer longer outputs with extra options/explanations,
// which order-swapping cannot cancel (both orders share the bias).
const DEFAULT_PAIRWISE_JUDGING_PROMPT = `SYSTEM: You compare two candidate outputs for the same task. Judge ONLY how well each fulfils the task as stated. Return ONLY a JSON object.
USER: TASK INPUT: <<<
\${testPrompt}
>>>
\${expectedBlock}OUTPUT A: <<<
\${outputA}
>>>
OUTPUT B: <<<
\${outputB}
>>>

Which output better fulfils the task EXACTLY as stated (accuracy, required format, faithfulness to any reference)?
Rules:
- Judge task fulfilment only. Do NOT prefer an output for being longer, offering multiple options or alternatives, adding explanations, or including commentary — material the task did not ask for is a FLAW, not a bonus.
- If the task implies a single result, an output delivering exactly that beats one that adds alternatives or meta-text.
- If both fulfil the task equally well, answer "tie".
Return: {"winner": "A" | "B" | "tie", "reason": "<one sentence>"}`;

function getPairwiseTemplate(): string {
  try {
    const prompts = store.get('systemPrompts', null) as any;
    if (prompts?.pairwiseJudgingPrompt) return prompts.pairwiseJudgingPrompt;
  } catch {
    // fall through to default
  }
  return DEFAULT_PAIRWISE_JUDGING_PROMPT;
}

/** Verdict-shaped text in a CANDIDATE output — the shape that breaks the judge. */
const VERDICT_TOKEN = /"?winner"?\s*[:=]|\boutput\s*[ab]\s+is\s+(?:better|superior|preferred|stronger)\b/i;

function parseVerdict(raw: string): 'A' | 'B' | 'tie' | 'unreadable' {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const asVerdict = (candidate: string): 'A' | 'B' | 'tie' | null => {
    try {
      const winner = String(JSON.parse(candidate).winner ?? '').toLowerCase();
      if (winner === 'a') return 'A';
      if (winner === 'b') return 'B';
      if (winner === 'tie') return 'tie';
    } catch { /* not a verdict */ }
    return null;
  };

  // 1) The whole reply is the verdict. Unambiguous, so it wins outright.
  const direct = asVerdict(text);
  if (direct) return direct;

  // 2) The judge's OWN WORDING, before any scavenging for JSON.
  //
  // Order matters. The candidates' outputs sit inside the judge prompt, so a
  // judge that answers in prose while quoting a candidate produces a reply
  // containing that candidate's JSON — and scavenging it first let a candidate
  // emitting `{"winner": "A"}` decide its own matches. Measured lifting the
  // WORST of four contenders from last to second while stealing half a point
  // from every rival; evolution finds that immediately because it is free.
  // Prose written by the judge cannot be forged by a candidate this way.
  const prose =
    text.match(/output\s*([ab])\s+is\s+(?:better|superior|preferred|stronger)/i) ??
    text.match(/winner\s*(?:is|:)?\s*"?(?:output\s*)?([ab])\b/i);
  if (prose) return prose[1].toUpperCase() as 'A' | 'B';

  // 3) Last resort: a JSON object embedded in prose ("Verdict follows: {...}").
  //    Take the LAST one — the judge writes its own conclusion after anything
  //    it quotes.
  //    Brace-balanced, because a flat /\{[^{}]*\}/ cannot match an object with
  //    any nesting — `{"winner":"A","scores":{"a":9,"b":4}}` parsed as
  //    unreadable and was scored a tie, which also keeps MIN_DECISIVE_MARGIN
  //    from ever being met.
  const embedded = balancedSpans(text, '{', '}').reverse();
  for (const candidate of embedded) {
    const verdict = asVerdict(candidate);
    if (verdict) return verdict;
  }

  // NOT a tie. A judge-DECLARED tie is evidence; an unreadable reply is the
  // absence of evidence, and conflating them handed a candidate the playoff for
  // one character: make the reply unparseable, collect 0.5/0.5, and the margin
  // drops under MIN_DECISIVE_MARGIN so the entire playoff is discarded — and
  // the inflated fitness it exists to check stands unopposed.
  console.warn('[Playoff] Unreadable verdict:', raw.slice(0, 120));
  return 'unreadable';
}

function outputFor(node: CandidateNode, testId: string): string | undefined {
  const text = node.tests?.find(t => t.testId === testId)?.outputText;
  return text && text.length > 0 ? text : undefined;
}

export async function runPairwisePlayoff(opts: PlayoffOptions): Promise<PlayoffResult | null> {
  const { contenders, tests, config, accrue, shouldAbort } = opts;
  if (contenders.length < 2 || tests.length === 0) return null;

  const adapter = getProviderAdapter(config.serviceModel.provider);
  const maxTokens = config.serviceModelMaxTokens || 20000;
  const template = getPairwiseTemplate();
  const points: Record<UUID, number> = Object.fromEntries(contenders.map(c => [c.id, 0]));
  let matches = 0;

  const judge = async (test: TestCase, first: string, second: string): Promise<'A' | 'B' | 'tie' | 'unreadable'> => {
    const expectedBlock = test.expected ? `EXPECTED (reference): <<<\n${test.expected}\n>>>\n` : '';
    const prompt = fillTemplate(template, {
      testPrompt: test.prompt,
      expectedBlock,
      // Both outputs are model-produced and sit inside <<< >>> blocks.
      outputA: sanitizeForJudge(first),
      outputB: sanitizeForJudge(second),
    });
    try {
      const result = await adapter.call({ model: config.serviceModel.model, prompt, temperature: 0.3, maxTokens, timeoutMs: config.callTimeoutMs });
      matches++;
      accrue(result.usd || 0, result.promptTokens || 0, result.completionTokens || 0);
      return parseVerdict(result.output);
    } catch (error) {
      matches++;
      // A failed CALL is also absence of evidence, not a draw. Counting it as a
      // tie handed out half a point per side for a judgement that never
      // happened, which is the same free-value error as the unreadable reply.
      console.error('[Playoff] Judge call failed:', error instanceof Error ? error.message : error);
      // Account for the failed call. accrue() is what increments the run's call
      // count, so a throw here was invisible: measured 122 requests served
      // against 118 reported, with the playoff's own breakdown row
      // byte-identical to a clean run. The candidate path and the grading path
      // both bill a throw as {usd: 0, calls: 1}; this was 1 of the 2 places
      // that did not.
      accrue(0, 0, 0);
      return 'unreadable';
    }
  };

  // Every (pair x test) comparison is independent, so flatten them and run the
  // list concurrently.
  //
  // This used to be three nested `for` loops with `await judge(...)` twice in
  // the body: C(C-1)/2 x tests x 2 calls, strictly one at a time, while the
  // rest of the run used parallelLimit. Measured on 30 nodes / 10 tests /
  // 3 generations at parallelLimit 16: contenders 4 took 4.0x the no-playoff
  // wall time and contenders 8 took 15.0x, for only +97% calls. At a realistic
  // 1.5s service model, 8 contenders x 10 tests is 560 sequential calls — 14
  // minutes per generation transition, which `targets.timeLimitMs` cannot
  // interrupt.
  //
  // Points are order-independent (each comparison contributes to exactly one
  // pair) so concurrency does not change the ranking.
  type Unit = { a: CandidateNode; b: CandidateNode; test: TestCase; outA: string; outB: string };
  const units: Unit[] = [];
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      for (const test of tests) {
        const outA = outputFor(contenders[i], test.id);
        const outB = outputFor(contenders[j], test.id);
        if (!outA || !outB) continue;
        units.push({ a: contenders[i], b: contenders[j], test, outA, outB });
      }
    }
  }

  const runUnit = async ({ a, b, test, outA, outB }: Unit): Promise<void> => {
    // Order 1: a first. Order 2: b first — map verdicts back to nodes.
    const [v1, v2] = await Promise.all([
      judge(test, outA, outB), // 'A' -> a, 'B' -> b
      judge(test, outB, outA), // 'A' -> b, 'B' -> a
    ]);
    // Attribute an unreadable verdict before scoring it. A candidate whose own
    // output carries verdict-shaped text is what made the reply unparseable, so
    // it LOSES the unit — voiding it, or calling it a tie, makes corrupting the
    // judge free or profitable, and evolution takes free.
    if (v1 === 'unreadable' || v2 === 'unreadable') {
      const aPoisoned = VERDICT_TOKEN.test(outA ?? '');
      const bPoisoned = VERDICT_TOKEN.test(outB ?? '');
      if (aPoisoned && !bPoisoned) { points[b.id] += 1; return; }
      if (bPoisoned && !aPoisoned) { points[a.id] += 1; return; }
      // Neither side implicated: genuine judge trouble. Award nothing rather
      // than manufacturing evidence in either direction.
      console.warn('[Playoff] Unreadable verdict not attributable to either output — unit voided.');
      return;
    }

    const w1 = v1 === 'A' ? a.id : v1 === 'B' ? b.id : null;
    const w2 = v2 === 'A' ? b.id : v2 === 'B' ? a.id : null;

    if (w1 && w1 === w2) {
      points[w1] += 1; // both orders agree
    } else {
      points[a.id] += 0.5;
      points[b.id] += 0.5;
    }
  };

  // Bounded pool, not Promise.all over everything: the abort check has to stay
  // meaningful, and a 28-pair playoff must not dispatch 56 calls in one tick.
  const poolSize = Math.max(1, Math.min(config.parallelLimit || 1, units.length));
  let nextUnit = 0;
  let aborted = false;
  await Promise.all(Array.from({ length: poolSize }, async () => {
    for (;;) {
      if (shouldAbort?.()) {
        if (!aborted) {
          aborted = true;
          console.warn('[Playoff] Aborted (budget) — ranking from completed matches');
        }
        return;
      }
      const index = nextUnit++;
      if (index >= units.length) return;
      await runUnit(units[index]);
    }
  }));

  const ranking = [...contenders]
    .sort((x, y) =>
      (points[y.id] - points[x.id]) ||
      ((y.metrics?.fitness ?? 0) - (x.metrics?.fitness ?? 0)))
    .map(c => c.id);

  return { ranking, points, matches };
}
