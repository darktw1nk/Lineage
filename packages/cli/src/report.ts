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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findNodeById(result: EvolutionResult, nodeId: string): EvolutionResultNode | null {
  for (const gen of result.generations) {
    for (const node of gen.nodes) {
      if (node.id === nodeId) return node;
    }
  }
  return null;
}

function computeGenStats(nodes: EvolutionResultNode[]): { avg: number; best: number; worst: number } {
  const fitnesses: number[] = [];
  for (const n of nodes) {
    if (n.metrics?.fitness !== undefined) {
      fitnesses.push(n.metrics.fitness);
    }
  }
  if (fitnesses.length === 0) return { avg: 0, best: 0, worst: 0 };
  const sum = fitnesses.reduce((a, b) => a + b, 0);
  return {
    avg: sum / fitnesses.length,
    best: Math.max(...fitnesses),
    worst: Math.min(...fitnesses),
  };
}

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
  return text.replace(/\|/g, '\\|');
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
  cliConfig: CliConfig,
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

  lines.push(`| Custom grading prompt | ${cliConfig.systemPrompts?.llmGradingPrompt ? 'Yes' : 'No'} |`);
  lines.push(`| Duration | ${formatDuration(result.durationMs)} |`);
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
    const models = Object.keys(result.costBreakdown).filter(k => k.startsWith('model:'));
    if (models.length > 0) {
      lines.push('');
      lines.push('**By model:** ' + models.map(m => `${m.slice(6)} $${result.costBreakdown![m].usd.toFixed(4)} (${result.costBreakdown![m].calls} calls)`).join(', '));
    }
    lines.push('');
  }

  // ---- Fitness Progression ----
  lines.push('## Fitness Progression');
  lines.push('');
  lines.push('| Gen | Avg Fitness | Best Fitness | Worst Fitness |');
  lines.push('|-----|------------|-------------|--------------|');

  for (let i = 0; i < result.generations.length; i++) {
    const gen = result.generations[i];
    const stats = computeGenStats(gen.nodes);
    const isFinal = i === result.generations.length - 1;
    const prefix = isFinal ? '**' : '';
    const suffix = isFinal ? '**' : '';
    lines.push(`| ${prefix}${gen.generation}${suffix} | ${prefix}${stats.avg.toFixed(3)}${suffix} | ${prefix}${stats.best.toFixed(3)}${suffix} | ${prefix}${stats.worst.toFixed(3)}${suffix} |`);
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
    lines.push('```');
    lines.push(seedNode.prompt);
    lines.push('```');
    lines.push('');

    if (seedNode.tests && seedNode.tests.length > 0) {
      lines.push('### Seed Test Results');
      lines.push('');
      for (let t = 0; t < seedNode.tests.length; t++) {
        const test = seedNode.tests[t];
        const testDef = config.testSet[t];
        const testName = testDef?.name ?? `Test ${t + 1}`;
        lines.push(`**Test ${t + 1}: ${testName}** — Score: **${test.score}**/10`);
        lines.push(`> Input: ${escapeMarkdown(truncate(testDef?.prompt, 200))}`);
        lines.push(`> Output: ${escapeMarkdown(truncate(test.outputText, 300))}`);
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
    lines.push(`*Champion selected by pairwise playoff (${lastPlayoff.ranking.length} contenders, both-orders judging).*`);
    lines.push('');
  }

  if (bestNode && result.best) {
    lines.push(`**Fitness:** ${result.best.fitness.toFixed(3)}  `);
    lines.push(`**Quality:** ${result.best.quality.toFixed(1)}  `);
    lines.push(`**Generation:** ${result.best.generation}  `);
    lines.push(`**Temperature:** ${bestNode.params.temperature}  `);
    lines.push(`**Model:** ${result.best.model}  `);
    lines.push('');
    lines.push('```');
    lines.push(bestNode.prompt);
    lines.push('```');
    lines.push('');

    if (bestNode.tests && bestNode.tests.length > 0) {
      lines.push('### Best Prompt Test Results');
      lines.push('');
      for (let t = 0; t < bestNode.tests.length; t++) {
        const test = bestNode.tests[t];
        const testDef = config.testSet[t];
        const testName = testDef?.name ?? `Test ${t + 1}`;
        lines.push(`**Test ${t + 1}: ${testName}** — Score: **${test.score}**/10`);
        lines.push(`> Input: ${escapeMarkdown(truncate(testDef?.prompt, 200))}`);
        lines.push(`> Output: ${escapeMarkdown(truncate(test.outputText, 300))}`);
        lines.push('');
      }
    }
  } else {
    lines.push('*No best prompt found (evolution may have failed).*');
    lines.push('');
  }

  // ---- Improvement Summary ----
  lines.push('## Improvement Summary');
  lines.push('');

  if (seedNode?.tests && bestNode?.tests && seedNode.tests.length > 0) {
    lines.push('| # | Test | Seed Score | Best Score | Delta |');
    lines.push('|---|------|-----------|-----------|-------|');

    let seedTotal = 0;
    let bestTotal = 0;

    for (let t = 0; t < config.testSet.length; t++) {
      const testName = config.testSet[t]?.name ?? `Test ${t + 1}`;
      const seedScore = seedNode.tests[t]?.score ?? 0;
      const bestScore = bestNode.tests[t]?.score ?? 0;
      const delta = bestScore - seedScore;
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      seedTotal += seedScore;
      bestTotal += bestScore;
      lines.push(`| ${t + 1} | ${escapeMarkdown(testName)} | ${seedScore.toFixed(1)} | ${bestScore.toFixed(1)} | ${deltaStr} |`);
    }

    const count = config.testSet.length;
    const seedAvg = seedTotal / count;
    const bestAvg = bestTotal / count;
    const avgDelta = bestAvg - seedAvg;
    const avgDeltaStr = avgDelta > 0 ? `+${avgDelta.toFixed(1)}` : avgDelta.toFixed(1);
    lines.push(`| | **Average** | **${seedAvg.toFixed(1)}** | **${bestAvg.toFixed(1)}** | **${avgDeltaStr}** |`);
    lines.push('');
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
    }
  }

  // ---- Analysis: Wins, Losses & Why ----
  if (seedNode?.tests && bestNode?.tests && seedNode.tests.length > 0) {
    lines.push('## Analysis');
    lines.push('');

    const wins: string[] = [];
    const losses: string[] = [];
    const unchanged: string[] = [];

    for (let t = 0; t < config.testSet.length; t++) {
      const testName = config.testSet[t]?.name ?? `Test ${t + 1}`;
      const seedScore = seedNode.tests[t]?.score ?? 0;
      const bestScore = bestNode.tests[t]?.score ?? 0;
      const delta = bestScore - seedScore;
      const seedReason = extractJustification(seedNode.tests[t]?.llmGradeReasoning);
      const bestReason = extractJustification(bestNode.tests[t]?.llmGradeReasoning);

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
          lines.push(`- **[${change.label}]** (${genLabel}): ${change.text}`);
        }
      }
    } else {
      // Fallback: just show the best node's own changelog
      for (const change of bestNode.changeLog) {
        lines.push(`- **[${change.label}]**: ${change.text}`);
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
