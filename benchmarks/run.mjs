/**
 * Does evolution beat just asking a good model to rewrite the prompt once?
 *
 * Three arms per task, all scored on the SAME held-out tests, by the same
 * grader, on the same candidate model with the same parameters:
 *
 *   A  seed        the hand-written starting prompt
 *   B  one-shot    that prompt rewritten once by a strong model, given the
 *                  training examples and their expected answers
 *   C  evolution   the champion of a full run
 *
 * Arms A and C come free from one evolution run: the engine scores the seed
 * AND the champion on the holdout at the end, using the champion's model and
 * parameters, so the comparison isolates the prompt. Arm B is a second run
 * whose seed IS the rewrite and which does no evolving (1 candidate, 1
 * generation, no operators), so its holdout row is scored by the identical path.
 *
 *   node benchmarks/run.mjs [taskFile ...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'benchmarks', 'out');
const DB = path.join(OUT, 'bench.db');
fs.mkdirSync(OUT, { recursive: true });

const tasks = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, 'benchmarks', 'tasks')).sort()
      .map(f => path.join(ROOT, 'benchmarks', 'tasks', f));

const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });

/**
 * Run the CLI on a config and return its parsed results.json — or reuse the
 * previous result if it is already on disk. These arms cost real money; a
 * crash in a later step must not re-bill an arm that already finished.
 */
function runCli(configPath, outPath) {
  if (fs.existsSync(outPath)) {
    console.error(`  (reusing ${path.basename(outPath)})`);
    return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  }
  sh('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json', 'packages/cli/src/index.ts',
    '--config', configPath, '--db', DB, '--output', outPath, '--report', 'none']);
  return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
}

const rows = [];

for (const taskFile of tasks) {
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  const name = task.name;
  console.error(`\n=== ${name} ===`);

  // --- arms A + C: one evolution run ---
  const evoOut = path.join(OUT, `${name}-evolution.json`);
  const evo = runCli(taskFile, evoOut);
  const seedHoldout = evo.holdout?.seed?.score;
  const champHoldout = evo.holdout?.champion?.score;
  const seedTrain = evo.generations?.[0]?.nodes?.find(n => n.changeLog?.[0]?.text?.includes('Seed prompt'))?.metrics?.quality;

  // --- arm B: one-shot rewrite, scored through the same path ---
  const rewritePath = path.join(OUT, `${name}-oneshot.txt`);
  const metaPath = path.join(OUT, `${name}-oneshot-meta.json`);
  let meta;
  if (fs.existsSync(rewritePath) && fs.existsSync(metaPath)) {
    console.error(`  (reusing ${path.basename(rewritePath)})`);
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } else {
    meta = JSON.parse(sh('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json',
      'benchmarks/oneshot.mts', taskFile, rewritePath, DB]).trim());
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }
  const rewrite = fs.readFileSync(rewritePath, 'utf-8');

  const oneShotConfig = {
    ...task,
    name: `${name}-oneshot`,
    seedPrompt: rewrite,
    populationSize: 1, generationSize: 1, maxGenerations: 1,
    operators: { mutationShare: 0, crossoverShare: 0,
      metaPrompting: { enabled: false, share: 0 },
      paramVariation: { enabled: false, share: 0 },
      modelVariation: { enabled: false, share: 0 } },
  };
  const oneShotConfigPath = path.join(OUT, `${name}-oneshot.json`);
  fs.writeFileSync(oneShotConfigPath, JSON.stringify(oneShotConfig, null, 2));
  const oneShotOut = path.join(OUT, `${name}-oneshot-result.json`);
  const one = runCli(oneShotConfigPath, oneShotOut);

  rows.push({
    task: name,
    mode: task.testSet.find(t => t.holdout)?.mode ?? 'mixed',
    seed: { holdout: seedHoldout, train: seedTrain, usd: 0 },
    oneShot: { holdout: one.holdout?.seed?.score, usd: one.totals.usd + meta.usd },
    evolution: { holdout: champHoldout, usd: evo.totals.usd },
    champion: evo.best?.prompt,
    rewrite,
  });

  const r = rows[rows.length - 1];
  console.error(`--- ${name}: seed ${fmt(r.seed.holdout)} | one-shot ${fmt(r.oneShot.holdout)} ($${r.oneShot.usd.toFixed(4)}) | evolution ${fmt(r.evolution.holdout)} ($${r.evolution.usd.toFixed(4)})`);
}

function fmt(v) { return typeof v === 'number' ? v.toFixed(2) : 'n/a'; }

fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));

// ---- report ----
const lines = [];
lines.push('# Does evolution beat a one-shot rewrite?', '');
lines.push('All three arms are scored on the same held-out tests, by the same grader, on the same');
lines.push('candidate model and parameters. Held-out tests are never seen during evolution.', '');
lines.push('| Task | Seed | One-shot rewrite | Evolution | Evolution vs one-shot | Cost (one-shot / evolution) |');
lines.push('|---|:---:|:---:|:---:|:---:|:---:|');
for (const r of rows) {
  const delta = (typeof r.evolution.holdout === 'number' && typeof r.oneShot.holdout === 'number')
    ? (r.evolution.holdout - r.oneShot.holdout) : null;
  const d = delta === null ? 'n/a' : (delta > 0 ? `**+${delta.toFixed(2)}**` : delta.toFixed(2));
  lines.push(`| ${r.task} | ${fmt(r.seed.holdout)} | ${fmt(r.oneShot.holdout)} | ${fmt(r.evolution.holdout)} | ${d} | $${r.oneShot.usd.toFixed(4)} / $${r.evolution.usd.toFixed(4)} |`);
}
lines.push('');
const wins = rows.filter(r => typeof r.evolution.holdout === 'number' && typeof r.oneShot.holdout === 'number' && r.evolution.holdout > r.oneShot.holdout).length;
const ties = rows.filter(r => r.evolution.holdout === r.oneShot.holdout).length;
lines.push(`**Evolution beat the one-shot rewrite on ${wins} of ${rows.length} tasks** (${ties} tie${ties === 1 ? '' : 's'}).`);
lines.push('');
for (const r of rows) {
  lines.push(`## ${r.task}`, '');
  lines.push('**One-shot rewrite:**', '', '```text', r.rewrite.trim(), '```', '');
  lines.push('**Evolution champion:**', '', '```text', String(r.champion ?? '(none)').trim(), '```', '');
}
fs.writeFileSync(path.join(ROOT, 'benchmarks', 'RESULTS.md'), lines.join('\n'));
console.error(`\nWrote benchmarks/RESULTS.md — evolution won ${wins}/${rows.length}`);
