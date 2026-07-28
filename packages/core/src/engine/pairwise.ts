/**
 * Pairwise playoff: round-robin comparison of top contenders' STORED outputs,
 * judged by the service model in BOTH orders per pair to cancel position bias.
 * Produces a Copeland ranking used to sharpen selection/elite/champion.
 * Absolute fitness is not modified.
 */
import type { CandidateNode, TestCase, EvaluationConfig, UUID } from '../types.js';
import { getProviderAdapter } from '../providers/index.js';
import { store } from '../store.js';

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

function parseVerdict(raw: string): 'A' | 'B' | 'tie' {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // 1) Direct JSON, or a JSON object embedded in surrounding prose
  const jsonCandidates = [text];
  const embedded = text.match(/\{[\s\S]*?\}/);
  if (embedded) jsonCandidates.push(embedded[0]);
  for (const candidate of jsonCandidates) {
    try {
      const winner = String(JSON.parse(candidate).winner ?? '').toLowerCase();
      if (winner === 'a') return 'A';
      if (winner === 'b') return 'B';
      if (winner === 'tie') return 'tie';
    } catch {
      // try next candidate
    }
  }

  // 2) Prose fallback — judges sometimes answer in plain text despite the
  //    JSON-only instruction (observed live with gemini flash-lite)
  const prose =
    text.match(/output\s*([ab])\s+is\s+(?:better|superior|preferred|stronger)/i) ??
    text.match(/winner\s*(?:is|:)?\s*"?(?:output\s*)?([ab])\b/i);
  if (prose) return prose[1].toUpperCase() as 'A' | 'B';

  console.warn('[Playoff] Unparseable verdict, counting as tie:', raw.slice(0, 120));
  return 'tie';
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

  const judge = async (test: TestCase, first: string, second: string): Promise<'A' | 'B' | 'tie'> => {
    const expectedBlock = test.expected ? `EXPECTED (reference): <<<\n${test.expected}\n>>>\n` : '';
    const prompt = template
      .replace(/\$\{testPrompt\}/g, test.prompt)
      .replace(/\$\{expectedBlock\}/g, expectedBlock)
      .replace(/\$\{outputA\}/g, first)
      .replace(/\$\{outputB\}/g, second);
    try {
      const result = await adapter.call({ model: config.serviceModel.model, prompt, temperature: 0.3, maxTokens, timeoutMs: config.callTimeoutMs });
      matches++;
      accrue(result.usd || 0, result.promptTokens || 0, result.completionTokens || 0);
      return parseVerdict(result.output);
    } catch (error) {
      matches++;
      console.error('[Playoff] Judge call failed, counting as tie:', error instanceof Error ? error.message : error);
      return 'tie';
    }
  };

  outer:
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      if (shouldAbort?.()) {
        console.warn('[Playoff] Aborted between pairs (budget) — ranking from completed matches');
        break outer;
      }
      const a = contenders[i];
      const b = contenders[j];
      for (const test of tests) {
        const outA = outputFor(a, test.id);
        const outB = outputFor(b, test.id);
        if (!outA || !outB) continue;

        // Order 1: a first. Order 2: b first — map verdicts back to nodes.
        const v1 = await judge(test, outA, outB); // 'A' -> a, 'B' -> b
        const v2 = await judge(test, outB, outA); // 'A' -> b, 'B' -> a
        const w1 = v1 === 'A' ? a.id : v1 === 'B' ? b.id : null;
        const w2 = v2 === 'A' ? b.id : v2 === 'B' ? a.id : null;

        if (w1 && w1 === w2) {
          points[w1] += 1; // both orders agree
        } else {
          points[a.id] += 0.5;
          points[b.id] += 0.5;
        }
      }
    }
  }

  const ranking = [...contenders]
    .sort((x, y) =>
      (points[y.id] - points[x.id]) ||
      ((y.metrics?.fitness ?? 0) - (x.metrics?.fitness ?? 0)))
    .map(c => c.id);

  return { ranking, points, matches };
}
