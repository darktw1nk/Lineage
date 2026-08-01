/**
 * The BASELINE arm: ask a strong model to improve the prompt once.
 *
 * It is given exactly what a competent engineer would hand it — the current
 * prompt and the training examples with their expected answers — and one shot
 * to rewrite. This is the thing evolution has to beat to be worth its cost.
 *
 *   npx tsx --tsconfig packages/cli/tsconfig.json benchmarks/oneshot.mts <task.json> <out.txt>
 */
import fs from 'node:fs';
import { format } from 'node:util';
import { installStoreShim } from '../packages/cli/src/engine.js';
import { getProviderAdapter, initializeDatabase, closeDatabase } from '@lineage/core';

// Adapters log with console.log. stdout here is a data channel — the runner
// parses it as JSON — so route every log line to stderr, exactly as the CLI does.
const toStderr = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

const [, , taskPath, outPath, dbPath] = process.argv;
if (!taskPath || !outPath) {
  console.error('usage: oneshot.mts <task.json> <out.txt> [db]');
  process.exit(2);
}

const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
installStoreShim(task.apiKeys ?? {});
// The price catalog lives in the database; without it every call records $0
// and this arm's cost — the number the whole comparison turns on — is a lie.
await initializeDatabase(dbPath ?? './benchmarks/.bench.db');

const train = task.testSet.filter((t: any) => !t.holdout);
const examples = train.map((t: any, i: number) =>
  `Example ${i + 1}\nINPUT:\n${t.prompt}\nEXPECTED OUTPUT:\n${t.expected ?? '(graded against a rubric — no single reference)'}`,
).join('\n\n');

const rewritePrompt = `You are an expert prompt engineer. Improve the following system prompt so it scores as well as possible on the task shown by the examples.

CURRENT PROMPT:
<<<
${task.seedPrompt}
>>>

TRAINING EXAMPLES (the prompt will be run on inputs like these; the expected outputs show exactly what good looks like):

${examples}

Rewrite the prompt so a model following it produces outputs matching the expected form as closely as possible. Return ONLY the new prompt text — no preamble, no explanation, no delimiters.`;

const [provider, ...rest] = String(task.serviceModel).split('/');
const model = rest.join('/');
const adapter = getProviderAdapter(provider as any);

const result = await adapter.call({
  model,
  prompt: rewritePrompt,
  temperature: 0.3,
  maxTokens: 4096,
  timeoutMs: 120_000,
});

const text = (result.output ?? '').trim().replace(/^<<<\s*|\s*>>>$/g, '').trim();
if (!text) {
  console.error('one-shot rewrite returned nothing');
  process.exit(1);
}

fs.writeFileSync(outPath, text, 'utf-8');
closeDatabase();
console.error(`[oneshot] ${task.name}: ${text.length} chars, $${result.usd.toFixed(6)}`);
process.stdout.write(JSON.stringify({ usd: result.usd, calls: 1, chars: text.length }) + '\n');
