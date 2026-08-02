/**
 * Has the model catalog drifted from what providers actually serve?
 *
 * The catalog in `packages/core/src/database/init.ts` is a hardcoded list with
 * a date in a comment. Nothing checks it, so it rots silently in two
 * directions, and both cost real money:
 *
 *   - A catalogued model the provider has RETIRED 404s mid-run. The node
 *     fails, the run continues, and the budget was spent on nothing.
 *   - A callable model MISSING from the catalog is priced at $0 by
 *     `getModelCost`, so its calls bill nothing on paper, `totals.usd` never
 *     grows, and `budget` can never trip. The engine warns at run time, but by
 *     then you have already chosen the model.
 *
 * Provider APIs list available models but do NOT publish pricing, so this
 * cannot auto-update prices — it reports drift for a human to act on. Adding a
 * model means adding its price by hand, deliberately.
 *
 *   node scripts/check-models.mjs
 *
 * Exit code 1 when a catalogued model is no longer callable (the case that
 * breaks runs), 0 otherwise, so CI can gate on it.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'packages', 'core', 'src', 'database', 'init.ts');

/** Model ids that are not general chat completions — noise in a drift report. */
const NON_CHAT = /image|tts|robotics|computer-use|omni|lyria|nano-banana|embedding|aqa|veo|imagen/i;

const catalogued = (provider) => {
  const src = fs.readFileSync(SRC, 'utf-8');
  const re = new RegExp(`provider: '${provider}', model: '([^']+)'`, 'g');
  return new Set([...src.matchAll(re)].map(m => m[1]));
};

async function geminiLive(key) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
  if (!res.ok) throw new Error(`Gemini list failed: ${res.status}`);
  const body = await res.json();
  return new Set((body.models ?? [])
    .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map(m => m.name.replace('models/', '')));
}

async function openaiLive(key) {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`OpenAI list failed: ${res.status}`);
  const body = await res.json();
  return new Set((body.data ?? []).map(m => m.id));
}

const PROVIDERS = [
  { name: 'gemini', env: 'GEMINI_API_KEY', fetchList: geminiLive },
  { name: 'openai', env: 'OPENAI_API_KEY', fetchList: openaiLive },
];

let retired = 0;
for (const p of PROVIDERS) {
  const key = process.env[p.env];
  const cat = catalogued(p.name);
  if (!key) {
    console.log(`\n${p.name}: skipped (${p.env} not set) — ${cat.size} catalogued model(s) unverified`);
    continue;
  }
  let live;
  try {
    live = await p.fetchList(key);
  } catch (err) {
    console.log(`\n${p.name}: could not reach provider — ${String(err).slice(0, 90)}`);
    continue;
  }

  const gone = [...cat].filter(m => !live.has(m));
  const missing = [...live].filter(m => !cat.has(m) && !NON_CHAT.test(m));

  console.log(`\n${p.name}: ${cat.size} catalogued, ${live.size} callable`);
  if (gone.length) {
    retired += gone.length;
    console.log('  RETIRED — catalogued but no longer callable (these 404 mid-run):');
    for (const m of gone.sort()) console.log(`    ${m}`);
  } else {
    console.log('  no catalogued model has been retired');
  }
  if (missing.length) {
    console.log('  UNCATALOGUED — callable but unpriced, so they bill $0 and budget cannot trip:');
    for (const m of missing.sort()) console.log(`    ${m}`);
  }
}

console.log('\nProviders do not publish pricing via API, so prices must be added by hand in');
console.log(`${path.relative(ROOT, SRC)}. This reports drift; it does not fix it.`);

if (retired > 0) {
  console.log(`\nFAIL: ${retired} catalogued model(s) no longer exist.`);
  process.exit(1);
}
