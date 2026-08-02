import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installSkill, skillSourcePath } from '../src/installSkill.js';

/**
 * `--install-skill` exists because the skill is the agent-facing entry point and
 * it did not ship. `.claude/skills/evolving-prompts/SKILL.md` lives in the repo,
 * so anyone who installed the published package — the path the README now leads
 * with — could not get it without cloning. An agent told "use the Lineage skill"
 * would find nothing.
 *
 * Rules:
 *  - Writes where the agent actually looks, and says where that was.
 *  - Never clobbers a customised skill without being asked.
 *  - Fails loudly if the packaged skill is missing, rather than writing an empty
 *    file that an agent would then read as instructions.
 */
let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the skill ships with the package', () => {
  it('resolves to a real file inside the installed package', () => {
    const src = skillSourcePath();
    expect(fs.existsSync(src), `packaged skill missing at ${src}`).toBe(true);
    const text = fs.readFileSync(src, 'utf-8');
    // A skill without frontmatter is not loadable by Claude Code.
    expect(text.startsWith('---')).toBe(true);
    expect(text).toMatch(/^name:\s*evolving-prompts/m);
    expect(text).toMatch(/^description:/m);
  });
});

describe('installing it', () => {
  it('writes SKILL.md into a named directory', () => {
    const res = installSkill(dir);
    const written = path.join(dir, 'evolving-prompts', 'SKILL.md');
    expect(res.path).toBe(written);
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf-8')).toMatch(/^name:\s*evolving-prompts/m);
  });

  it('creates missing parent directories', () => {
    const nested = path.join(dir, 'a', 'b', 'skills');
    installSkill(nested);
    expect(fs.existsSync(path.join(nested, 'evolving-prompts', 'SKILL.md'))).toBe(true);
  });

  it('refuses to overwrite an existing skill by default', () => {
    installSkill(dir);
    const target = path.join(dir, 'evolving-prompts', 'SKILL.md');
    fs.writeFileSync(target, '--- CUSTOMISED BY THE USER ---');
    const res = installSkill(dir);
    expect(res.skipped).toBe(true);
    // The user's edits survive: silently replacing them would discard work with
    // no way to get it back.
    expect(fs.readFileSync(target, 'utf-8')).toContain('CUSTOMISED');
  });

  it('overwrites when explicitly asked', () => {
    installSkill(dir);
    const target = path.join(dir, 'evolving-prompts', 'SKILL.md');
    fs.writeFileSync(target, 'stale');
    const res = installSkill(dir, { force: true });
    expect(res.skipped).toBeFalsy();
    expect(fs.readFileSync(target, 'utf-8')).toMatch(/^name:\s*evolving-prompts/m);
  });

  it('reports the absolute path it wrote, so the caller can print it', () => {
    const res = installSkill(dir);
    expect(path.isAbsolute(res.path)).toBe(true);
  });
});

describe('default target', () => {
  it('defaults to the user-level Claude skills directory', () => {
    const res = installSkill(undefined, { dryRun: true });
    // Must land where Claude Code looks for personal skills, not in cwd.
    expect(res.path.replace(/\\/g, '/')).toMatch(/\.claude\/skills\/evolving-prompts\/SKILL\.md$/);
    expect(res.path.startsWith(os.homedir())).toBe(true);
  });

  it('dry run writes nothing', () => {
    const res = installSkill(dir, { dryRun: true });
    expect(fs.existsSync(res.path)).toBe(false);
  });
});
