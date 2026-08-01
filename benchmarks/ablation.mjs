/**
 * Do the search features actually help?
 *
 * Four mechanisms were added on the theory that they improve the search:
 * adaptive operator rates, diversity, novelty, and stagnation restart. Theory
 * is not evidence. This runs each task twice with the SAME seed — once with
 * every feature off (the historical default) and once with all four on — and
 * compares the number that matters: the held-out score.
 *
 * Same seed per pair means operator plans, parent assignment, temperatures and
 * the holdout split are identical; the only difference is the search
 * behaviour. Multiple seeds per task give some sense of the noise floor, which
 * matters because LLM judging is noisy and a single pair proves nothing.
 *
 *   node benchmarks/ablation.mjs [seeds] [taskFile ...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'benchmarks', 'out', 'ablation');
const DB = path.join(OUT, 'ablation.db');
fs.mkdirSync(OUT, { recursive: true });

const SEEDS = [301, 302];
const TASKS = fs.readdirSync(path.join(ROOT, 'benchmarks', 'tasks')).sort()
  .filter(f => f.endsWith('.json'))
  .map(f => path.join(ROOT, 'benchmarks', 'tasks', f));

/** Everything off — what the engine did before today. */
const ARM_OFF = {
  selection: { diversity: 0, novelty: 0 },
  operators: { adaptivity: 0 },
};

/** Everything on, at middling strengths. */
const ARM_ON = {
  selection: { diversity: 0.5, novelty: 0.5, restartAfter: 2 },
  operators: { adaptivity: 0.7 },
};

const sh = (cmd, args) => execFileSync(cmd, args, {
  cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});

function runOnce(task, arm, armName, seed) {
  const name = `${task.name}-${armName}-s${seed}`;
  const outPath = path.join(OUT, `${name}.json`);
  if (fs.existsSync(outPath)) {
    console.error(`  (reusing ${name})`);
    return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  }
  const cfg = {
    ...task,
    name,
    seed,
    maxGenerations: 4,
    populationSize: 6,
    generationSize: 6,
    budget: 1.0,
    selection: { policy: 'topk', topK: 3, eliteShare: 0.1, ...arm.selection },
    operators: { ...task.operators, ...arm.operators },
  };
  const cfgPath = path.join(OUT, `${name}-config.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json', 'packages/cli/src/index.ts',
    '--config', cfgPath, '--db', DB, '--output', outPath, '--report', 'none']);
  return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
}

const rows = [];
for (const taskFile of TASKS) {
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  for (const seed of SEEDS) {
    console.error(`\n=== ${task.name} seed ${seed} ===`);
    const off = runOnce(task, ARM_OFF, 'off', seed);
    const on = runOnce(task, ARM_ON, 'on', seed);
    const holdout = r => r.holdout?.champion?.score;
    const seedScore = r => r.holdout?.seed?.score;
    rows.push({
      task: task.name, seed,
      seedBaseline: seedScore(off),
      offHoldout: holdout(off), onHoldout: holdout(on),
      offUsd: off.totals.usd, onUsd: on.totals.usd,
    });
    const r = rows[rows.length - 1];
    console.error(`  off ${fmt(r.offHoldout)} ($${r.offUsd.toFixed(4)})  |  on ${fmt(r.onHoldout)} ($${r.onUsd.toFixed(4)})`);
  }
}

function fmt(v) { return typeof v === 'number' ? v.toFixed(2) : 'n/a'; }

fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));

// ---- report ----
const L = [];
L.push('# Do the search features help?', '');
L.push('Each row is one task at one seed, run twice: **off** = the engine as it behaved before');
L.push('(no adaptivity, diversity, novelty or restart), **on** = all four enabled');
L.push('(`adaptivity 0.7`, `diversity 0.5`, `novelty 0.5`, `restartAfter 2`). Same seed per pair, so');
L.push('operator plans, parent assignment and the holdout split are identical — the only difference');
L.push('is the search behaviour. Scores are on **held-out tests**.', '');
L.push('| Task | Seed | Seed prompt | Off | On | Δ | Cost off / on |');
L.push('|---|:---:|:---:|:---:|:---:|:---:|:---:|');
let wins = 0, losses = 0, ties = 0;
for (const r of rows) {
  const d = (typeof r.onHoldout === 'number' && typeof r.offHoldout === 'number')
    ? r.onHoldout - r.offHoldout : null;
  if (d !== null) { if (d > 0.001) wins++; else if (d < -0.001) losses++; else ties++; }
  const ds = d === null ? 'n/a' : (d > 0 ? `**+${d.toFixed(2)}**` : d.toFixed(2));
  L.push(`| ${r.task} | ${r.seed} | ${fmt(r.seedBaseline)} | ${fmt(r.offHoldout)} | ${fmt(r.onHoldout)} | ${ds} | $${r.offUsd.toFixed(4)} / $${r.onUsd.toFixed(4)} |`);
}
L.push('');
L.push(`**${wins} better, ${losses} worse, ${ties} identical** across ${rows.length} paired runs.`);
const totalOff = rows.reduce((a, r) => a + r.offUsd, 0);
const totalOn = rows.reduce((a, r) => a + r.onUsd, 0);
L.push('');
L.push(`Total spend: $${totalOff.toFixed(4)} off, $${totalOn.toFixed(4)} on.`);
fs.writeFileSync(path.join(ROOT, 'benchmarks', 'ABLATION.md'), L.join('\n'));
console.error(`\nWrote benchmarks/ABLATION.md — ${wins} better / ${losses} worse / ${ties} tied`);
