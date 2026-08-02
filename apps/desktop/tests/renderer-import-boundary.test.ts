import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The renderer runs in a browser context with contextIsolation and no
 * nodeIntegration — `require` does not exist there.
 *
 * A single runtime import of the engine barrel (`import { selectChampion }
 * from '@voxor/lineage-core'`) pulled database/init.ts (sql.js, fs, path) and ajv
 * into the renderer bundle; vite-plugin-electron-renderer rewrote those Node
 * built-ins to `const ED=require, Ft=ED("path")`, and the PRODUCTION window
 * threw `ReferenceError: require is not defined` before React mounted — a
 * blank app. Dev mode was unaffected, so nothing caught it: `npm run build`
 * produced installers whose window renders nothing.
 *
 * Engine logic the renderer genuinely shares (the champion rule) is exported
 * as the browser-safe `@voxor/lineage-core/champion` subpath instead.
 */
const SRC = path.resolve(__dirname, '../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe('renderer source never imports the engine barrel at runtime', () => {
  const files = walk(SRC);

  it('finds renderer sources to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('has no value import of @voxor/lineage-core outside a type position', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      // Strip line comments so the explanatory notes about this very rule
      // do not trip it.
      const code = text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      for (const m of code.matchAll(/(^|\n)\s*import\s+([\s\S]*?)from\s+['"]@lineage\/core['"]/g)) {
        const clause = m[2];
        // `import type { X } from` and `import type * as` are erased at build
        // time and are fine; anything else emits a real module import.
        if (!/^\s*type\b/.test(clause)) {
          offenders.push(`${path.relative(SRC, file)}: import ${clause.trim().slice(0, 60)}…`);
        }
      }
      for (const m of code.matchAll(/(^|\n)\s*export\s+([\s\S]*?)from\s+['"]@lineage\/core['"]/g)) {
        if (!/^\s*type\b/.test(m[2])) {
          offenders.push(`${path.relative(SRC, file)}: export ${m[2].trim().slice(0, 60)}…`);
        }
      }
    }
    expect(offenders, `renderer files importing the engine barrel:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the champion subpath IS used, so the rule is still shared with the engine', () => {
    const centerView = fs.readFileSync(path.join(SRC, 'components/CenterView.tsx'), 'utf-8');
    expect(centerView).toContain("from '@voxor/lineage-core/champion'");
  });
});

describe('the built renderer bundle contains no Node require', () => {
  const distAssets = path.resolve(__dirname, '../dist/assets');

  it('has no `require(` outside string literals in any built chunk', () => {
    if (!fs.existsSync(distAssets)) {
      // Nothing built in this checkout — the source-level guard above is the
      // one that runs everywhere; this asserts the actual artifact when present.
      return;
    }
    const chunks = fs.readdirSync(distAssets).filter(f => f.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const js = fs.readFileSync(path.join(distAssets, chunk), 'utf-8');
      // `x=require` / `require(` as executable code. Ajv embeds require(...)
      // inside quoted code-generation strings, which never execute here.
      const bare = js.match(/[^"'`\w.]require\s*[(,;]/g) ?? [];
      const executable = bare.filter(hit => !/["'`]/.test(hit));
      expect(executable, `${chunk} contains executable require`).toEqual([]);
    }
  });
});
