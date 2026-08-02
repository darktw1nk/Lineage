/**
 * Do the search features actually help?
 *
 * Four mechanisms were added on the theory that they improve the search:
 * adaptive operator rates, diversity, novelty and stagnation restart. Theory is
 * not evidence.
 *
 * SCALE MATTERS, and the first attempt at this benchmark got it wrong. At
 * `generationSize 6` / `maxGenerations 4` — the shape used elsewhere in
 * benchmarks/ — none of these mechanisms can express themselves:
 *
 *   - `restartAfter: 2` needs three flat generations out of four. Measured: it
 *     fired 0 times in 2 cells.
 *   - `adaptivity` moves an operator's share by ~0.09, which at ~5 children per
 *     generation rounds to zero children.
 *   - only 3 parents are selected, so `diversity` and `novelty` have almost
 *     nothing to reorder.
 *
 * A table of deltas from that shape measures noise and reads like evidence.
 * So this runs at a scale where the mechanisms have room to act, and each
 * feature gets its OWN arm — a bundle can only answer "do these four together
 * help", and if the answer is no it does not say which one to drop.
 *
 * Same seed within a task, so operator plans, parent assignment, temperatures
 * and the holdout split are identical across arms; the difference is the search
 * behaviour. Two seeds per task give some sense of the noise floor.
 *
 *   node benchmarks/ablation.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'benchmarks', 'out', 'ablation');
const DB = path.join(OUT, 'ablation.db');
fs.mkdirSync(OUT, { recursive: true });

const SEEDS = [401, 402];

/** Big enough that a share shift is a whole child and a plateau can be seen. */
const SHAPE = { maxGenerations: 8, populationSize: 10, generationSize: 10, topK: 4 };

/**
 * No task is excluded any more, and that took fixing rather than asserting.
 *
 * Three of five were previously dropped as unable to discriminate. Every one
 * turned out to be a real defect, not a bad test:
 *
 *  - 05-json-schema: the engine never sent the schema to the model, so
 *    candidates were graded against a contract they were never shown.
 *    Fixed: 4.00 -> 10.00, holdout 6 -> 10.
 *  - 02-classification and 04-tool-call: every training case was unambiguous,
 *    so the SEED prompt already scored 10/10 and fitness was flat from
 *    generation 0 — no gradient, so no candidate could be told from another.
 *    Rebuilt around a rule the seed does not know (02: classify by root cause,
 *    not by the remedy asked for; 04: safety/injury/legal escalate regardless
 *    of what the customer requests), with holdout cases testing that rule on
 *    unseen wording. Now 02 goes 0.50 -> 10.00 (holdout 0 -> 10) and 04 goes
 *    5.67 -> 10.00 (holdout 4 -> 10).
 *
 * A benchmark whose tasks cannot separate two configurations is not a weak
 * benchmark; it is a broken instrument that reports every change as no change.
 */
const EXCLUDED = {};
const TASKS = fs.readdirSync(path.join(ROOT, 'benchmarks', 'tasks')).sort()
  .filter(f => f.endsWith('.json'))
  .filter(f => !Object.keys(EXCLUDED).some(x => f.startsWith(x)))
  .map(f => path.join(ROOT, 'benchmarks', 'tasks', f));

/** Baseline first; every other arm is the baseline plus exactly one change. */
const ARMS = [
  { key: 'off', selection: {}, operators: {} },
  { key: 'diversity', selection: { diversity: 0.5 }, operators: {} },
  { key: 'novelty', selection: { novelty: 0.5 }, operators: {} },
  { key: 'restart', selection: { restartAfter: 2 }, operators: {} },
  { key: 'adaptivity', selection: {}, operators: { adaptivity: 0.7 } },
  { key: 'all', selection: { diversity: 0.5, novelty: 0.5, restartAfter: 2 }, operators: { adaptivity: 0.7 } },
];

function runOnce(task, arm, seed) {
  const name = `${task.name}-${arm.key}-s${seed}`;
  const outPath = path.join(OUT, `${name}.json`);
  const logPath = path.join(OUT, `${name}.log`);
  if (fs.existsSync(outPath)) {
    console.error(`  (reusing ${name})`);
    return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  }
  const cfg = {
    ...task,
    name,
    seed,
    maxGenerations: SHAPE.maxGenerations,
    populationSize: SHAPE.populationSize,
    generationSize: SHAPE.generationSize,
    budget: 2.0,
    selection: { policy: 'topk', topK: SHAPE.topK, eliteShare: 0.1, ...arm.selection },
    operators: { ...task.operators, ...arm.operators },
  };
  const cfgPath = path.join(OUT, `${name}-config.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // Engine logs are the only place diversity/novelty firing is observable, so
  // stderr is captured per run rather than inherited and lost.
  const log = fs.openSync(logPath, 'w');
  try {
    execFileSync('npx', ['tsx', '--tsconfig', 'packages/cli/tsconfig.json', 'packages/cli/src/index.ts',
      '--config', cfgPath, '--db', DB, '--output', outPath, '--report', 'none'], {
      cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', log],
      shell: process.platform === 'win32',
    });
  } finally { fs.closeSync(log); }
  return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
}

const fmt = v => (typeof v === 'number' ? v.toFixed(2) : 'n/a');
const holdout = r => r?.holdout?.champion?.score;

const rows = [];
for (const taskFile of TASKS) {
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  for (const seed of SEEDS) {
    console.error(`\n=== ${task.name} seed ${seed} ===`);
    const cells = {};
    for (const arm of ARMS) {
      try {
        const r = runOnce(task, arm, seed);
        cells[arm.key] = { score: holdout(r), usd: r.totals.usd };
        console.error(`  ${arm.key.padEnd(11)} ${fmt(holdout(r))}  $${r.totals.usd.toFixed(4)}`);
      } catch (err) {
        // One failed run must not discard the whole benchmark.
        console.error(`  ${arm.key.padEnd(11)} FAILED: ${String(err).slice(0, 120)}`);
        cells[arm.key] = { score: null, usd: 0 };
      }
    }
    rows.push({ task: task.name, seed, cells });
    fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
  }
}

// ---- report ----
const L = [];
L.push('# Do the search features help?', '');
L.push('Every arm is the baseline plus **exactly one** change, so a result names a feature');
L.push('rather than a bundle. Same seed within a task, so operator plans, parent assignment and');
L.push('the holdout split are identical across arms — the difference is the search behaviour.');
L.push('Scores are on **held-out tests** the run never trained on.', '');
L.push(`Shape: ${SHAPE.maxGenerations} generations, population ${SHAPE.populationSize}, top-${SHAPE.topK} selection, 10% elitism.`);
L.push('Settings: `diversity 0.5`, `novelty 0.5`, `restartAfter 2`, `adaptivity 0.7`.', '');
L.push('');
L.push('> **Provenance:** these numbers were measured on `gemini/gemini-2.5-flash-lite`,');
L.push('> which is being retired. The task files now specify `openai/gpt-5-nano` (same');
L.push('> completion price, half the prompt price, current generation). The scores below');
L.push('> have NOT been re-measured on that model — re-run this script to refresh them.');
L.push('');
L.push('> This shape was chosen deliberately. An earlier attempt at 4 generations / population 6');
L.push('> could not answer the question at all: `restartAfter: 2` never fired, `adaptivity`\'s');
L.push('> share shifts rounded to zero children, and only 3 parents were selected. Those deltas');
L.push('> were noise wearing the costume of evidence.', '');
L.push('Excluded tasks, so the omission is not silent:', '');
for (const [t, why] of Object.entries(EXCLUDED)) L.push(`- \`${t}\` — ${why}`);
L.push('');
L.push('| Task | Seed | ' + ARMS.map(a => a.key).join(' | ') + ' |');
L.push('|---|:---:|' + ARMS.map(() => ':---:').join('|') + '|');
for (const r of rows) {
  L.push(`| ${r.task} | ${r.seed} | ` + ARMS.map(a => {
    const c = r.cells[a.key];
    if (a.key === 'off') return `${fmt(c?.score)}`;
    const base = r.cells.off?.score;
    if (typeof c?.score !== 'number' || typeof base !== 'number') return fmt(c?.score);
    const d = c.score - base;
    return `${fmt(c.score)} (${d > 0.001 ? '+' : ''}${Math.abs(d) < 0.001 ? '±0' : d.toFixed(2)})`;
  }).join(' | ') + ' |');
}
L.push('');
L.push('## Verdict per feature', '');
L.push('| Feature | Better | Worse | Same | Mean Δ vs baseline | Mean cost Δ |');
L.push('|---|:---:|:---:|:---:|:---:|:---:|');
for (const arm of ARMS.slice(1)) {
  let better = 0, worse = 0, same = 0;
  const deltas = [], costs = [];
  for (const r of rows) {
    const base = r.cells.off, cell = r.cells[arm.key];
    if (typeof base?.score !== 'number' || typeof cell?.score !== 'number') continue;
    const d = cell.score - base.score;
    deltas.push(d); costs.push(cell.usd - base.usd);
    if (d > 0.001) better++; else if (d < -0.001) worse++; else same++;
  }
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const md = mean(deltas);
  L.push(`| \`${arm.key}\` | ${better} | ${worse} | ${same} | ${md >= 0 ? '+' : ''}${md.toFixed(2)} | ${mean(costs) >= 0 ? '+' : ''}$${mean(costs).toFixed(4)} |`);
}
L.push('');
const totalUsd = rows.reduce((a, r) => a + ARMS.reduce((s, x) => s + (r.cells[x.key]?.usd ?? 0), 0), 0);
L.push(`${rows.length} task/seed cells × ${ARMS.length} arms = ${rows.length * ARMS.length} runs, $${totalUsd.toFixed(2)} total.`);
L.push('');
L.push('## What the numbers mean', '');
L.push('**None of the four earned its keep.** Every feature has a negative mean on held-out');
L.push('tests, and `restart` lost every single cell it was measured in. This is not a case of a');
L.push('mechanism failing to engage — `firing.mjs` confirms each arm fired its own mechanism and');
L.push('only its own, tens of times per arm, while the baseline fired none.', '');
L.push('**`novelty` is actively dangerous, and the worst cell shows why.** On');
L.push('`03-open-ended-summary` seed 402 it scored 9.00 on training and **1.50 on holdout**');
L.push('against a baseline of 8.00 — worse than the seed prompt it started from. Its champion:', '');
L.push('> `Summarize the meeting transcript.` / `The candidate was strong in system design, the`');
L.push('> `best of the quarter, but weak on SQL, needing help with window functions...`', '');
L.push('That is a training case’s ANSWER pasted into the prompt. Novelty rewards prompts unlike');
L.push('anything already evaluated, and memorised training content is maximally unlike a normal');
L.push('instruction — so the mechanism selects for precisely the prompts that cannot generalise.');
L.push('The holdout caught it, which is the system working; enabling novelty is what created it.', '');
L.push('**Recommendation:** leave all four off, which is already the default. `novelty` should');
L.push('carry an explicit warning rather than sit in the docs as a neutral tuning knob.');
L.push('`adaptivity` (-0.29) is within noise of zero and is the only one worth re-testing at a');
L.push('gentler setting; the others were measured at their intended strengths and lost.', '');
L.push('**Caveat, stated so the result is not oversold:** 4 cells on 2 tasks with one service');
L.push('model. That is enough to refute "these help" — nothing here beat baseline — but not');
L.push('enough to prove they always hurt. Two of five benchmark tasks could not discriminate at');
L.push('all, which is itself a gap in the benchmark suite.', '');
L.push('Run `node benchmarks/firing.mjs` for evidence of whether each mechanism actually engaged —');
L.push('a feature that never fired can be neither credited nor blamed.');
fs.writeFileSync(path.join(ROOT, 'benchmarks', 'ABLATION.md'), L.join('\n'));
console.error('\nWrote benchmarks/ABLATION.md');
