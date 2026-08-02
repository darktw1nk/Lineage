/**
 * Did each feature actually ENGAGE?
 *
 * A feature that never ran can be neither credited nor blamed, and a score
 * table cannot tell the two apart — "no effect" and "never fired" produce an
 * identical row. This counts, per arm, how often each mechanism actually did
 * something.
 *
 * Evidence comes from the ENGINE LOGS, which state what happened, rather than
 * from inference over results.json. An earlier version of this script guessed
 * at adaptivity by watching the operator-label mix shift between generations;
 * it reported "no shift" for runs whose logs showed the meta share moving
 * 0.45 -> 0.68, because realized child counts quantize the change away. A
 * detector that disagrees with the engine's own account of itself is worse
 * than no detector — it produces confident wrong answers.
 *
 *   node benchmarks/firing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'out', 'ablation');
const ARMS = ['off', 'diversity', 'novelty', 'restart', 'adaptivity', 'all'];

const count = (text, re) => (text.match(re) ?? []).length;

const byArm = new Map(ARMS.map(a => [a, {
  cells: 0, diversity: 0, novelty: 0, restart: 0, adaptivity: 0, spliced: 0, merged: 0, missingLog: 0,
}]));

for (const f of fs.readdirSync(DIR).sort()) {
  const m = /^(.+?)-(off|diversity|novelty|restart|adaptivity|all)-s(\d+)\.json$/.exec(f);
  if (!m) continue;
  const [, , arm] = m;
  const acc = byArm.get(arm);
  acc.cells++;

  const logPath = path.join(DIR, f.replace(/\.json$/, '.log'));
  if (!fs.existsSync(logPath)) { acc.missingLog++; continue; }
  const log = fs.readFileSync(logPath, 'utf-8');

  acc.diversity += count(log, /Diversity [\d.]+: swapped/g);
  acc.novelty += count(log, /Novelty [\d.]+: re-ranked/g);
  acc.restart += count(log, /Best fitness flat for/g);
  acc.adaptivity += count(log, /Adaptivity [\d.]+:/g);
  acc.spliced += count(log, /at section boundaries/g);
  acc.merged += count(log, /^\[Crossover\]/gm);
}

console.log('How often each mechanism actually fired, per arm (engine logs):\n');
console.log('arm          cells  diversity  novelty  restart  adaptivity');
for (const arm of ARMS) {
  const a = byArm.get(arm);
  if (!a.cells) continue;
  console.log(
    `${arm.padEnd(12)} ${String(a.cells).padStart(5)}  ${String(a.diversity).padStart(9)}` +
    `  ${String(a.novelty).padStart(7)}  ${String(a.restart).padStart(7)}  ${String(a.adaptivity).padStart(10)}`,
  );
}

const missing = [...byArm.values()].reduce((s, a) => s + a.missingLog, 0);
if (missing) console.log(`\n${missing} run(s) had no captured log — their firing counts are unknown, not zero.`);

console.log('\nA zero in a feature\'s own arm means the mechanism never engaged, and any');
console.log('score delta for that arm is noise rather than an effect of the feature.');
