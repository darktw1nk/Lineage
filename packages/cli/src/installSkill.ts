/**
 * Install the `evolving-prompts` agent skill.
 *
 * The skill is how a coding agent learns to drive this tool — which models to
 * pick, why meta-prompting is the only failure-aware operator, that the holdout
 * number is the one worth reporting. It lived only at
 * `.claude/skills/evolving-prompts/SKILL.md` inside the repo, so every user who
 * installed the published package (the path the README leads with) had no way
 * to get it short of cloning. An agent told "use the Lineage skill" found
 * nothing at all.
 *
 * So the skill is now packaged, and this writes it where an agent looks.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/** Where the skill file sits inside the installed package. */
export function skillSourcePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Built to dist/, so the asset sits beside the bundle; from source it is two
  // levels up in the repo. Try both rather than assuming which one is running.
  const candidates = [
    path.join(here, 'skill', 'SKILL.md'),
    path.join(here, '..', 'skill', 'SKILL.md'),
    path.join(here, '..', '..', '..', '.claude', 'skills', 'evolving-prompts', 'SKILL.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return path.resolve(candidates[0]);
}

/** Claude Code's personal skills directory. */
export function defaultSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

export interface InstallResult {
  /** Absolute path of the SKILL.md that was (or would be) written. */
  path: string;
  /** True when an existing skill was left untouched. */
  skipped?: boolean;
}

export function installSkill(
  targetDir?: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): InstallResult {
  const dir = targetDir ?? defaultSkillDir();
  const dest = path.resolve(path.join(dir, 'evolving-prompts', 'SKILL.md'));

  if (opts.dryRun) return { path: dest };

  const src = skillSourcePath();
  if (!fs.existsSync(src)) {
    // Fail loudly. Writing an empty file would hand an agent a skill that says
    // nothing, which is worse than having no skill at all.
    throw new Error(
      `The packaged skill is missing (looked for ${src}). This is a packaging bug — please report it.`,
    );
  }

  if (fs.existsSync(dest) && !opts.force) {
    return { path: dest, skipped: true };
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { path: dest };
}
