/**
 * CLI Markdown Report Generator
 *
 * Generates a markdown report after a CLI evolution run, summarizing
 * configuration, fitness progression, seed vs best prompt, and improvements.
 */

import type { EvaluationConfig } from '@promptengine/core';
import type { EvolutionResult, EvolutionResultNode } from './engine.js';
import type { CliConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // An all-non-ASCII name (e.g. "日本語") reduces to '', so every such run wrote
  // to the same output-.md and clobbered the previous one.
  return slug || 'run';
}

/**
 * Look up a test definition by id.
 *
 * node.tests holds only the FITNESS tests — holdout tests are removed before
 * evaluation — so pairing it positionally with config.testSet shifted every
 * name, input and output as soon as anything was held out, and silently
 * attributed one test's scores to another.
 */
function findTestDef(config: EvaluationConfig, testId: string | undefined) {
  return testId ? config.testSet.find(t => t.id === testId) : undefined;
}

/**
 * Fence content with enough backticks to survive fences inside it. Prompts that
 * contain a ```json example — the everyday case for this tool — terminated the
 * block early and let the rest of the prompt render as prose.
 */
function fenced(content: string): string[] {
  const longestRun = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [fence, content, fence];
}

function findNodeById(result: EvolutionResult, nodeId: string): EvolutionResultNode | null {
  for (const gen of result.generations) {
    for (const node of gen.nodes) {
      if (node.id === nodeId) return node;
    }
  }
  return null;
}

function computeGenStats(nodes: EvolutionResultNode[]): { avg: number; best: number; worst: number; scored: number; failed: number } {
  const fitnesses: number[] = [];
  let failed = 0;
  for (const n of nodes) {
    if (n.status === 'failed') failed++;
    if (n.metrics?.fitness !== undefined) {
      fitnesses.push(n.metrics.fitness);
    }
  }
  if (fitnesses.length === 0) return { avg: 0, best: 0, worst: 0, scored: 0, failed };
  const sum = fitnesses.reduce((a, b) => a + b, 0);
  return {
    avg: sum / fitnesses.length,
    best: Math.max(...fitnesses),
    worst: Math.min(...fitnesses),
    scored: fitnesses.length,
    failed,
  };
}

const STOP_REASON_TEXT: Record<string, string> = {
  target: 'target fitness reached',
  generations: 'ran out of generations (maxGenerations)',
  budget: 'budget limit reached — the run was cut short',
  time: 'time limit reached — the run was cut short',
  manual: 'stopped manually',
  exhausted: 'no candidates left to evaluate',
  error: 'stopped by an error',
};

function formatWeights(config: EvaluationConfig): string {
  const w = config.fitness.weights;
  const parts: string[] = [];
  if (w.quality !== undefined) parts.push(`quality=${w.quality}`);
  if (w.safety !== undefined) parts.push(`safety=${w.safety}`);
  if (w.cost !== undefined) parts.push(`cost=${w.cost}`);
  if (w.latency !== undefined) parts.push(`latency=${w.latency}`);
  if (w.stability !== undefined) parts.push(`stability=${w.stability}`);
  return parts.join(', ');
}

function formatOperators(config: EvaluationConfig): string {
  const ops = config.operators;
  const parts: string[] = [];
  parts.push(`mutation=${ops.mutationShare.toFixed(2)}`);
  parts.push(`crossover=${ops.crossoverShare.toFixed(2)}`);
  if (ops.metaPrompting?.enabled) parts.push(`meta=${ops.metaPrompting.share.toFixed(2)}`);
  if (ops.paramVariation?.enabled) parts.push(`param=${ops.paramVariation.share.toFixed(2)}`);
  if (ops.modelVariation?.enabled) parts.push(`model=${ops.modelVariation.share.toFixed(2)}`);
  return parts.join(', ');
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '(empty)';
  const oneLine = text.replace(/\n/g, ' ');
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + '...';
}

function escapeMarkdown(text: string): string {
  // A newline inside a table cell ends the table: the row splits, and every
  // following row (including Average) renders as plain prose.
  //
  // `[` and `<` matter just as much and were missing. This escapes candidate
  // OUTPUT into `> Output:` blockquotes, so without them a candidate could put
  // a live external link and raw HTML into the artifact a human or an agent
  // reads to decide whether the run worked.
  // BOTH brackets: escaping only `[` leaves `\[click here](url)`, in which
  // `[click here](` is still a contiguous substring and still renders as a link.
  return text
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;');
}

/**
 * Neutralise model-written prose before it becomes report BODY text.
 *
 * Judge justifications and operator changelog entries are written by a model
 * while it is looking at a candidate's output, and both were interpolated raw.
 * That let generated text emit its own `## Improvement Summary` table and its
 * own `## Outcome` line — a report claiming "target fitness reached" for a run
 * that stopped on budget, with a forged +8.0 delta and an external link. The
 * report is the artifact a human or an agent reads to decide whether the run
 * worked, so nothing inside it may impersonate the report's own structure.
 */
function escapeMarkdownProse(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')     // no new block-level constructs
    .replace(/^\s*#/, '\\#')    // no headings even after the newline strip
    // BOTH brackets. The changelog template wraps the label in `**[...]**`, so
    // a label containing `]` closes the bracket the template opened and
    // `](http://…)` right after it renders as a live link — escaping only `[`
    // never touched that.
    .replace(/\[/g, '\\[')      // no links
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;')      // no raw HTML
    .replace(/\|/g, '\\|');     // no table rows
}

/**
 * A test's `score` is the MEAN across samples, but `outputText` and the
 * justification both come from samples[0]. With samples [10, 1, 1] the report
 * printed 'Score: 4/10' directly above the one output that passed, and a
 * 10/10 justification welded to a 4/10 score. Say which sample is on screen.
 */
function sampleNote(test: any): string {
  const samples: number[] = Array.isArray(test?.samples) ? test.samples : [];
  if (samples.length < 2) return '';
  return ` *(sample 1 of ${samples.length}; sample scores ${samples.join(', ')} — the score above is their mean)*`;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Report generator
// ---------------------------------------------------------------------------

export function generateReport(
  result: EvolutionResult,
  config: EvaluationConfig,
  // Optional: --resume without --config has no CLI config file. Only touch
  // fields through optional chaining in here.
  cliConfig?: Partial<CliConfig>,
): string {
  const lines: string[] = [];

  // ---- Header ----
  lines.push(`# ${config.name} — Run Report`);
  lines.push('');
  lines.push(`**Run:** ${config.name}`);
  lines.push(`**Date:** ${formatDate(result.startedAt)}`);
  lines.push(`**Run ID:** \`${result.runId}\``);
  if (result.seed !== undefined) {
    lines.push(`**Seed:** ${result.seed}`);
  }
  lines.push('');

  // ---- Run Configuration ----
  lines.push('## Run Configuration');
  lines.push('');
  lines.push('| Setting | Value |');
  lines.push('|---------|-------|');
  lines.push(`| Models | ${config.enabledModels.map(m => `${m.provider}/${m.model}`).join(', ')} |`);
  lines.push(`| Service model | ${config.serviceModel.provider}/${config.serviceModel.model} |`);
  lines.push(`| Population size | ${config.population.initialSize} |`);
  lines.push(`| Generation size | ${config.population.generationSize} |`);
  lines.push(`| Generations | ${config.targets.maxGenerations ?? 'unlimited'} |`);
  lines.push(`| Selection | ${config.selection.policy}${config.selection.policy === 'topk' ? ` (k=${config.selection.topK})` : ` (p=${config.selection.topP})`}, elite=${config.selection.eliteShare ?? 0} |`);
  lines.push(`| Fitness weights | ${formatWeights(config)} |`);
  lines.push(`| Operators | ${formatOperators(config)} |`);

  const tempConfig = config.operators.paramVariation?.temperature;
  if (tempConfig?.enabled) {
    lines.push(`| Temperature range | ${tempConfig.min} – ${tempConfig.max} |`);
  }

  lines.push(`| Custom grading prompt | ${cliConfig?.systemPrompts?.llmGradingPrompt ? 'Yes' : 'No'} |`);
  // On a resumed run the wall-clock span from the ORIGINAL start includes the
  // downtime, so an overnight gap read as "8h 40m" for ten minutes of work.
  const resumed = result.activeDurationMs !== undefined && result.durationMs - result.activeDurationMs > 60_000;
  lines.push(
    resumed
      ? `| Duration | ${formatDuration(result.activeDurationMs)} working (${formatDuration(result.durationMs)} wall clock, resumed) |`
      : `| Duration | ${formatDuration(result.durationMs)} |`,
  );
  lines.push(`| Cost | $${result.totals.usd.toFixed(4)} |`);
  lines.push(`| API calls | ${result.totals.calls} |`);
  lines.push('');

  // ---- Where the money went ----
  if (result.costBreakdown) {
    lines.push('## Where the money went');
    lines.push('');
    if (result.estimate) {
      lines.push(`*Estimated: $${result.estimate.low.toFixed(4)} – $${result.estimate.high.toFixed(4)} (~${result.estimate.calls} calls) · Actual: $${result.totals.usd.toFixed(4)} (${result.totals.calls} calls)*`);
      lines.push('');
    }
    const estByLabel = new Map((result.estimate?.breakdown ?? []).map(b => [b.label, b]));
    const purposes = Object.keys(result.costBreakdown).filter(k => !k.startsWith('model:'));
    const allLabels = [...new Set([...purposes, ...estByLabel.keys()])];
    lines.push('| Purpose | Est. calls | Calls | Est. $ | Actual $ |');
    lines.push('|---|---|---|---|---|');
    for (const label of allLabels) {
      const act = result.costBreakdown[label];
      const est = estByLabel.get(label);
      lines.push(`| ${label} | ${est ? est.calls : '—'} | ${act ? act.calls : '—'} | ${est ? `$${est.low.toFixed(4)}–$${est.high.toFixed(4)}` : '—'} | ${act ? `$${act.usd.toFixed(4)}` : '—'} |`);
    }
    // Totals row: doubles as a visible sums-equal-totals check
    const actCalls = purposes.reduce((a, k) => a + result.costBreakdown![k].calls, 0);
    const actUsd = purposes.reduce((a, k) => a + result.costBreakdown![k].usd, 0);
    const estCalls = result.estimate ? result.estimate.calls : undefined;
    lines.push(`| **Total** | ${estCalls ?? '—'} | **${actCalls}** | ${result.estimate ? `$${result.estimate.low.toFixed(4)}–$${result.estimate.high.toFixed(4)}` : '—'} | **$${actUsd.toFixed(4)}** |`);

    const models = Object.keys(result.costBreakdown).filter(k => k.startsWith('model:'));
    if (models.length > 0) {
      lines.push('');
      lines.push('**By model:** ' + models.map(m => `${m.slice(6)} $${result.costBreakdown![m].usd.toFixed(4)} (${result.costBreakdown![m].calls} calls)`).join(', '));
    }
    lines.push('');
  }

  // ---- Outcome ----
  // The report used to say nothing about why the run ended or whether it failed,
  // so a run truncated by the budget cap read exactly like one that finished.
  lines.push('## Outcome');
  lines.push('');
  const totalFailed = result.generations.reduce((sum, g) => sum + g.nodes.filter(n => n.status === 'failed').length, 0);
  const totalNodes = result.generations.reduce((sum, g) => sum + g.nodes.length, 0);
  // A run where NOTHING worked is a failure, whatever the stop reason says.
  // 'exhausted' was rendered with a ✅ and the cheerful "no candidates left to
  // evaluate", so a run in which every single candidate died on a bad API key
  // opened with a green checkmark.
  const everythingFailed = totalNodes > 0 && totalFailed === totalNodes;

  if (result.error) {
    lines.push(`❌ **The run did not complete:** ${escapeMarkdown(result.error)}`);
  } else if (everythingFailed) {
    lines.push(`❌ **Every candidate failed** — this run produced nothing usable.`);
  } else if (result.stopReason) {
    const cut = result.stopReason === 'budget' || result.stopReason === 'time' ||
      result.stopReason === 'manual' || result.stopReason === 'exhausted' || result.stopReason === 'error';
    lines.push(`${cut ? '⚠️' : '✅'} **Stopped because:** ${STOP_REASON_TEXT[result.stopReason] ?? result.stopReason}`);
  } else {
    lines.push('**Stopped because:** (not recorded)');
  }

  // Name the actual cause. The per-node `error` was in results.json and
  // nowhere a human looks, so a report could say "no candidates left" without
  // ever mentioning "Incorrect API key provided".
  const firstError = result.generations
    .flatMap(g => g.nodes)
    .find(n => n.status === 'failed' && n.error)?.error;
  if (firstError) {
    lines.push('');
    lines.push(`**First failure:** ${escapeMarkdownProse(firstError)}`);
  }

  if (totalFailed > 0) {
    lines.push('');
    lines.push(`⚠️ **${totalFailed} of ${totalNodes} candidates failed** — the numbers below describe only the ones that completed.`);
  }
  if (result.holdout?.skipped) {
    lines.push('');
    lines.push(`⚠️ **Holdout evaluation was skipped** (${result.holdout.skipped}) — no generalization check was run.`);
  }
  lines.push('');

  // ---- Fitness Progression ----
  lines.push('## Fitness Progression');
  lines.push('');
  lines.push('| Gen | Avg Fitness | Best Fitness | Worst Fitness |');
  lines.push('|-----|------------|-------------|--------------|');

  if (result.generations.length === 0) {
    lines.push('| — | — | — | — |');
  }
  for (let i = 0; i < result.generations.length; i++) {
    const gen = result.generations[i];
    const stats = computeGenStats(gen.nodes);
    const isFinal = i === result.generations.length - 1;
    const prefix = isFinal ? '**' : '';
    const suffix = isFinal ? '**' : '';
    // A generation with no fitness at all rendered as 0.000, which reads as
    // "everything scored zero" rather than "nothing was scored".
    const cell = (value: number) => (stats.scored === 0 ? '—' : value.toFixed(3));
    const note = stats.failed > 0 ? ` ⚠️ ${stats.failed}/${gen.nodes.length} failed` : '';
    lines.push(`| ${prefix}${gen.generation}${suffix} | ${prefix}${cell(stats.avg)}${suffix} | ${prefix}${cell(stats.best)}${suffix} | ${prefix}${cell(stats.worst)}${suffix}${note} |`);
  }
  lines.push('');

  // ---- Seed Prompt (Baseline) ----
  const seedNode = result.generations[0]?.nodes[0] ?? null;

  lines.push('## Seed Prompt (Baseline)');
  lines.push('');

  if (seedNode) {
    lines.push(`**Fitness:** ${seedNode.metrics?.fitness?.toFixed(3) ?? 'N/A'}  `);
    lines.push(`**Quality:** ${seedNode.metrics?.quality?.toFixed(1) ?? 'N/A'}  `);
    lines.push(`**Model:** ${seedNode.params.model.provider}/${seedNode.params.model.model}  `);
    lines.push(`**Temperature:** ${seedNode.params.temperature}  `);
    lines.push('');
    lines.push(...fenced(seedNode.prompt));
    lines.push('');

    if (seedNode.tests && seedNode.tests.length > 0) {
      lines.push('### Seed Test Results');
      lines.push('');
      for (let t = 0; t < seedNode.tests.length; t++) {
        const test = seedNode.tests[t];
        const testDef = findTestDef(config, test.testId);
        const testName = testDef?.name ?? `Test ${t + 1}`;
        lines.push(`**Test ${t + 1}: ${escapeMarkdown(testName)}** — Score: **${test.score}**/10`);
        lines.push(`> Input: ${escapeMarkdown(truncate(testDef?.prompt, 200))}`);
        lines.push(`> Output: ${escapeMarkdown(truncate(test.outputText, 300))}${sampleNote(test)}`);
        lines.push('');
      }
    }
  } else {
    lines.push('*No seed node found.*');
    lines.push('');
  }

  // ---- Best Evolved Prompt ----
  const bestNode = result.best ? findNodeById(result, result.best.nodeId) : null;

  lines.push('## Best Evolved Prompt');
  lines.push('');

  if (result.playoffs && result.playoffs.length > 0) {
    const lastPlayoff = result.playoffs[result.playoffs.length - 1];
    const newestGeneration = result.generations
      .filter(g => g.nodes.some(n => n.status === 'finished' && n.metrics?.fitness !== undefined))
      .reduce((max, g) => Math.max(max, g.generation), -1);
    if (lastPlayoff.generation === newestGeneration && (lastPlayoff as any).decisive === false) {
      // The playoff ran but its top two were too close to act on, so selection
      // stayed fitness-based. Saying "selected by pairwise playoff" here put a
      // 5.000 champion three lines under a table reading "Best Fitness 10.000".
      lines.push(
        `*Champion selected by fitness. A pairwise playoff ran (${lastPlayoff.ranking.length} contenders) ` +
        `but its top two were too close to separate, so it did not override fitness.*`,
      );
    } else if (lastPlayoff.generation === newestGeneration) {
      lines.push(`*Champion selected by pairwise playoff (${lastPlayoff.ranking.length} contenders, both-orders judging).*`);
    } else {
      // Claiming a playoff picked the champion when the final generation never
      // held one is exactly backwards: that generation was ranked by fitness.
      lines.push(`*The last playoff covered generation ${lastPlayoff.generation}, not the final generation ${newestGeneration} — the champion below was selected by fitness.*`);
    }
    lines.push('');
  }

  if (bestNode && result.best) {
    lines.push(`**Fitness:** ${result.best.fitness.toFixed(3)}  `);
    lines.push(`**Quality:** ${result.best.quality.toFixed(1)}  `);
    lines.push(`**Generation:** ${result.best.generation}  `);
    lines.push(`**Temperature:** ${bestNode.params.temperature}  `);
    lines.push(`**Model:** ${result.best.model}  `);
    lines.push('');
    lines.push(...fenced(bestNode.prompt));
    lines.push('');

    if (bestNode.tests && bestNode.tests.length > 0) {
      lines.push('### Best Prompt Test Results');
      lines.push('');
      for (let t = 0; t < bestNode.tests.length; t++) {
        const test = bestNode.tests[t];
        const testDef = findTestDef(config, test.testId);
        const testName = testDef?.name ?? `Test ${t + 1}`;
        lines.push(`**Test ${t + 1}: ${escapeMarkdown(testName)}** — Score: **${test.score}**/10`);
        lines.push(`> Input: ${escapeMarkdown(truncate(testDef?.prompt, 200))}`);
        lines.push(`> Output: ${escapeMarkdown(truncate(test.outputText, 300))}${sampleNote(test)}`);
        lines.push('');
      }
    }
  } else {
    lines.push('*No best prompt found (evolution may have failed).*');
    lines.push('');
  }

  // ---- Improvement Summary ----
  //
  // This table is the number users quote, and on its own it is not evidence.
  // The champion was SELECTED for scoring highest on these very tests, out of
  // ~popSize x generations measurements; the seed got one. Against a judge with
  // a couple of points of per-call noise, that max-of-N vs single-draw
  // comparison reported an average +3.0 "improvement" in 20 of 20 runs where
  // the true improvement was measured to be exactly zero. Elitism then freezes
  // the lucky draw, so the number never regresses.
  const usesJudge = config.testSet.some(t => (t.mode ?? 'llm_grade') === 'llm_grade');
  // A PARTIAL holdout still ran. Requiring both halves printed "No holdout
  // ran" for a run where a holdout test was configured and the champion WAS
  // scored on it — the warning was simply false.
  const holdoutRan = !!(result.holdout && !result.holdout.skipped &&
    (result.holdout.seed || result.holdout.champion));

  // An unparseable judge reply is scored 5.0 — a number that LOOKS like a
  // grade. Measured: a seed reported exactly 5.0 on every test where the truth
  // was 1.0, and this table then printed '5.0 -> 7.0  +2.0' with every figure
  // fabricated. results.json was honest at the leaf; the report said nothing.
  const ungraded = (result as any).ungradedTests as number | undefined;
  if (ungraded && ungraded > 0) {
    lines.push(
      `> ⚠️ **${ungraded} test result(s) could not be graded** — the judge's reply was unparseable and each ` +
      'was scored 5.0. Those 5.0s are placeholders, not measurements, and they are included in the ' +
      'averages below. Treat any delta of similar size as noise.',
    );
    lines.push('');
  }

  lines.push('## Improvement Summary (training tests — selected-for)');
  lines.push('');
  lines.push(
    '> These are the tests evolution optimized against, and the champion was chosen for scoring well on them. ' +
    'Treat this as "what was selected", not as measured improvement.',
  );
  lines.push('');
  if (usesJudge && !holdoutRan) {
    lines.push(
      '> ⚠️ **No holdout ran, and this run is graded by an LLM judge.** With a noisy judge, picking the best of many ' +
      'measurements produces a positive delta here even when nothing actually improved. Add held-out tests ' +
      '(`"holdout": true`, or `holdoutShare`) and quote the Generalization number instead.',
    );
    lines.push('');
  }

  if (seedNode?.tests && bestNode?.tests && seedNode.tests.length > 0) {
    // The per-sample scores are collected and were then thrown away. A result
    // of 3.4 from samples [5,3,7,2,0] renders identically to a rock-solid 3.4,
    // and the spread is the one number that tells a user the measurement means
    // nothing. Show it whenever more than one sample was taken.
    const spreadOf = (test: any): string => {
      const samples: number[] = Array.isArray(test?.samples) ? test.samples : [];
      if (samples.length < 2) return '';
      return ` ±${((Math.max(...samples) - Math.min(...samples)) / 2).toFixed(1)}`;
    };
    const anySamples = seedNode.tests.some((t: any) => Array.isArray(t?.samples) && t.samples.length > 1);

    lines.push('| # | Test | Seed Score | Best Score | Delta |');
    lines.push('|---|------|-----------|-----------|-------|');

    let seedTotal = 0;
    let bestTotal = 0;
    let count = 0;

    // Iterate the tests that were actually RUN, matching seed to best by id.
    // Iterating config.testSet instead invented a 0.0/0.0 row for every
    // held-out test and dragged the average down with it.
    for (let t = 0; t < seedNode.tests.length; t++) {
      const seedTest = seedNode.tests[t];
      const bestTest = bestNode.tests.find(x => x.testId === seedTest.testId);
      if (!bestTest) continue;
      const testName = findTestDef(config, seedTest.testId)?.name ?? `Test ${t + 1}`;
      const seedScore = seedTest.score ?? 0;
      const bestScore = bestTest.score ?? 0;
      const delta = bestScore - seedScore;
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      seedTotal += seedScore;
      bestTotal += bestScore;
      count++;
      lines.push(
        `| ${count} | ${escapeMarkdown(testName)} | ${seedScore.toFixed(1)}${spreadOf(seedTest)} ` +
        `| ${bestScore.toFixed(1)}${spreadOf(bestTest)} | ${deltaStr} |`,
      );
    }

    const seedAvg = count > 0 ? seedTotal / count : 0;
    const bestAvg = count > 0 ? bestTotal / count : 0;
    const avgDelta = bestAvg - seedAvg;
    const avgDeltaStr = avgDelta > 0 ? `+${avgDelta.toFixed(1)}` : avgDelta.toFixed(1);
    lines.push(`| | **Average** | **${seedAvg.toFixed(1)}** | **${bestAvg.toFixed(1)}** | **${avgDeltaStr}** |`);
    lines.push('');
    if (anySamples) {
      lines.push('*± is half the observed spread across samples of the same test. A delta smaller than the spread is not a result.*');
      lines.push('');
    }
  } else {
    lines.push('*Insufficient data for comparison.*');
    lines.push('');
  }

  // ---- Generalization (holdout) ----
  if (result.holdout && (result.holdout.seed || result.holdout.champion || result.holdout.skipped)) {
    lines.push('## Generalization (holdout tests)');
    lines.push('');
    if (result.holdout.skipped) {
      lines.push(`Holdout evaluation skipped: ${result.holdout.skipped}`);
      lines.push('');
    } else if (result.holdout.seed && result.holdout.champion) {
      lines.push(`Scores on ${result.holdout.testIds.length} test(s) evolution never saw (${result.holdout.samplesPerTest} sample(s)/test):`);
      lines.push('');
      // The seed baseline is re-run with the CHAMPION's params, including any
      // model the run swapped to. That is deliberate — it isolates the prompt's
      // contribution — but "seed → champion" does not read that way, and a
      // reader would otherwise assume the baseline used the original model.
      lines.push('*Both rows use the champion\'s model and parameters, so this measures the PROMPT\'s contribution with any model change held constant.*');
      lines.push('');
      lines.push('| Test | Seed | Champion |');
      lines.push('|------|------|----------|');
      const testName = (id: string) => config.testSet.find(t => t.id === id)?.name ?? id.slice(0, 8);
      for (let i = 0; i < result.holdout.testIds.length; i++) {
        const tid = result.holdout.testIds[i];
        const s = result.holdout.seed.perTest.find(p => p.testId === tid)?.score ?? 0;
        const c = result.holdout.champion.perTest.find(p => p.testId === tid)?.score ?? 0;
        lines.push(`| ${escapeMarkdown(testName(tid))} | ${s.toFixed(1)} | ${c.toFixed(1)} |`);
      }
      lines.push(`| **Average** | **${result.holdout.seed.score.toFixed(2)}** | **${result.holdout.champion.score.toFixed(2)}** |`);
      lines.push('');
      // The whole point of a holdout is to catch a champion that won on the
      // training set and does NOT generalise. That case used to produce a green
      // tick and three '### Wins' lines and no callout at all, while the case
      // where a holdout is merely ABSENT got a loud warning.
      const delta = result.holdout.champion.score - result.holdout.seed.score;
      if (delta < 0) {
        lines.push(
          `> ⚠️ **The champion REGRESSED on unseen tests** (${result.holdout.seed.score.toFixed(2)} → ` +
          `${result.holdout.champion.score.toFixed(2)}, ${delta.toFixed(2)}). Evolution improved the training ` +
          'scores above by selecting for them; on tests it never saw, this prompt is WORSE than the seed. ' +
          'Treat the training deltas as overfitting, not as a result.',
        );
        lines.push('');
      }
    } else {
      // A PARTIAL holdout — the section was guarded on
      // (seed || champion || skipped) but the body only handled `skipped` or
      // BOTH halves, so a run whose circuit breaker fired between scoring the
      // champion and the seed emitted this heading followed by nothing at all.
      const half = result.holdout.champion ?? result.holdout.seed;
      const which = result.holdout.champion ? 'champion' : 'seed';
      lines.push(
        `⚠️ **The holdout evaluation is incomplete** — only the ${which} was scored ` +
        `(${half!.score.toFixed(2)} on ${result.holdout.testIds.length} unseen test(s)). ` +
        'Without both halves there is no baseline to compare against, so this number ' +
        'says nothing about whether the prompt improved. The run was cut short before ' +
        'the other half could be measured.',
      );
      lines.push('');
    }
  }

  // ---- Analysis: Wins, Losses & Why ----
  if (seedNode?.tests && bestNode?.tests && seedNode.tests.length > 0) {
    lines.push('## Analysis');
    lines.push('');

    const wins: string[] = [];
    const losses: string[] = [];
    const unchanged: string[] = [];

    for (let t = 0; t < seedNode.tests.length; t++) {
      const seedTest = seedNode.tests[t];
      const bestTest = bestNode.tests.find(x => x.testId === seedTest.testId);
      if (!bestTest) continue;
      const testName = findTestDef(config, seedTest.testId)?.name ?? `Test ${t + 1}`;
      const seedScore = seedTest.score ?? 0;
      const bestScore = bestTest.score ?? 0;
      const delta = bestScore - seedScore;
      // Model-written prose: must not be able to forge report structure.
      const seedReason = escapeMarkdownProse(extractJustification(seedTest.llmGradeReasoning));
      const bestReason = escapeMarkdownProse(extractJustification(bestTest.llmGradeReasoning));

      if (delta > 0) {
        wins.push(`- **${testName}** (+${delta.toFixed(0)}): Seed scored ${seedScore}${seedReason ? ` — ${seedReason}` : ''}. Best scored ${bestScore}${bestReason ? ` — ${bestReason}` : ''}.`);
      } else if (delta < 0) {
        losses.push(`- **${testName}** (${delta.toFixed(0)}): Seed scored ${seedScore}${seedReason ? ` — ${seedReason}` : ''}. Best scored ${bestScore}${bestReason ? ` — ${bestReason}` : ''}.`);
      } else {
        unchanged.push(`- **${testName}** (=${seedScore})`);
      }
    }

    if (wins.length > 0) {
      lines.push('### Wins');
      lines.push('');
      lines.push(...wins);
      lines.push('');
    }

    if (losses.length > 0) {
      lines.push('### Regressions');
      lines.push('');
      lines.push(...losses);
      lines.push('');
    }

    if (unchanged.length > 0) {
      lines.push('### Unchanged');
      lines.push('');
      lines.push(...unchanged);
      lines.push('');
    }
  }

  // ---- Prompt Changelog ----
  if (bestNode && bestNode.changeLog && bestNode.changeLog.length > 0) {
    lines.push('## Prompt Changes (Seed → Best)');
    lines.push('');

    // Walk the lineage from seed to best, collecting all changelogs
    const lineage = traceLineage(result, bestNode);

    if (lineage.length > 0) {
      for (const step of lineage) {
        const genLabel = `Gen ${step.generation}`;
        for (const change of step.changeLog) {
          // The label is model- and plugin-authored too; the sibling path below
          // escaped it and this one did not.
          lines.push(`- **[${escapeMarkdownProse(change.label)}]** (${genLabel}): ${escapeMarkdownProse(change.text)}`);
        }
      }
    } else {
      // Fallback: just show the best node's own changelog
      for (const change of bestNode.changeLog) {
        lines.push(`- **[${escapeMarkdownProse(change.label)}]**: ${escapeMarkdownProse(change.text)}`);
      }
    }
    lines.push('');
  } else if (bestNode && seedNode && bestNode.id === seedNode.id) {
    lines.push('## Prompt Changes (Seed → Best)');
    lines.push('');
    lines.push('*Best prompt is the seed — no mutations applied.*');
    lines.push('');
  }

  // ---- Prompt Diff ----
  if (seedNode && bestNode && seedNode.id !== bestNode.id) {
    lines.push('## Prompt Diff (Seed → Best)');
    lines.push('');
    const diff = computePromptDiff(seedNode.prompt, bestNode.prompt);
    if (diff.added.length === 0 && diff.removed.length === 0) {
      lines.push('*No textual differences (prompts are identical).*');
    } else {
      if (diff.removed.length > 0) {
        lines.push('**Removed:**');
        for (const line of diff.removed) {
          lines.push(`- ~~${escapeMarkdown(line)}~~`);
        }
        lines.push('');
      }
      if (diff.added.length > 0) {
        lines.push('**Added:**');
        for (const line of diff.added) {
          lines.push(`- ${escapeMarkdown(line)}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function extractJustification(reasoning: string | undefined): string {
  if (!reasoning) return '';
  try {
    let json = reasoning.trim();
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(json);
    return parsed.justification || '';
  } catch {
    return '';
  }
}

/**
 * Trace the lineage path from the seed node to the target node,
 * returning each ancestor's changelog in order (oldest first).
 */
function traceLineage(
  result: EvolutionResult,
  target: EvolutionResultNode,
): Array<{ generation: number; changeLog: EvolutionResultNode['changeLog'] }> {
  // Build a lookup of all nodes
  const nodeMap = new Map<string, EvolutionResultNode & { generation: number }>();
  for (const gen of result.generations) {
    for (const node of gen.nodes) {
      nodeMap.set(node.id, { ...node, generation: gen.generation });
    }
  }

  // Walk backwards from target to seed, following first parent
  const path: Array<{ generation: number; changeLog: EvolutionResultNode['changeLog'] }> = [];
  let current: (EvolutionResultNode & { generation: number }) | undefined = nodeMap.get(target.id);

  while (current && current.changeLog && current.changeLog.length > 0) {
    path.push({ generation: current.generation, changeLog: current.changeLog });
    const parentId = current.lineageParents[0];
    if (!parentId) break;
    current = nodeMap.get(parentId);
  }

  path.reverse();
  return path;
}

/**
 * Simple line-based diff between two prompts.
 * Returns lines present only in the old text (removed) and only in the new text (added).
 * Filters out empty lines and deduplicates.
 */
function computePromptDiff(
  oldPrompt: string,
  newPrompt: string,
): { added: string[]; removed: string[] } {
  const oldLines = oldPrompt.split('\n').map(l => l.trim()).filter(Boolean);
  const newLines = newPrompt.split('\n').map(l => l.trim()).filter(Boolean);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const removed = oldLines.filter(l => !newSet.has(l));
  const added = newLines.filter(l => !oldSet.has(l));

  // Deduplicate while preserving order
  return {
    removed: [...new Set(removed)],
    added: [...new Set(added)],
  };
}
