/**
 * Copy the agent skill into the package before publishing.
 *
 * The skill's canonical home is `.claude/skills/evolving-prompts/SKILL.md`,
 * where Claude Code picks it up while working IN this repo. Publishing a second
 * hand-maintained copy would guarantee the two drift, so it is copied at pack
 * time instead — one source of truth, shipped automatically.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.resolve(here, '..', '..', '..', '.claude', 'skills', 'evolving-prompts', 'SKILL.md');
const destDir = path.resolve(here, '..', 'skill');
const dest = path.join(destDir, 'SKILL.md');

if (!fs.existsSync(src)) {
  console.error(`copy-skill: cannot find the skill at ${src}`);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.error(`copy-skill: ${path.relative(process.cwd(), dest)} <- ${path.relative(process.cwd(), src)}`);
