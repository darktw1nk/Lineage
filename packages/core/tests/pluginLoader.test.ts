import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPlugins } from '../src/pluginLoader.js';
import { getOperator, listProviders, resetRegistry } from '../src/registry.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins');

beforeEach(() => resetRegistry());

describe('loadPlugins', () => {
  it('loads every module in a directory, capturing per-module errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifests = await loadPlugins({ dirs: [FIXTURES] });
    errSpy.mockRestore();

    const byName = new Map(manifests.map(m => [path.basename(m.source), m]));
    expect(byName.get('valid-operator.mjs')!.operators).toEqual(['reverse-prompt']);
    expect(byName.get('valid-provider.mjs')!.providers).toEqual(['echo']);
    expect(byName.get('combined.mjs')!.operators).toEqual(['noop-op']);
    expect(byName.get('broken.mjs')!.error).toMatch(/explodes/);
    expect(byName.get('invalid-shape.mjs')!.error).toMatch(/name/);
    expect(byName.get('index.mjs')!.operators).toEqual(['dir-op']); // dir-plugin/index.mjs

    expect(getOperator('reverse-prompt')).toBeDefined();
    expect(getOperator('dir-op')).toBeDefined();
    expect(listProviders()).toContain('echo');
  });

  it('loads explicit paths', async () => {
    const manifests = await loadPlugins({ paths: [path.join(FIXTURES, 'valid-operator.mjs')] });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeDefined();
  });

  it('skips disabled plugins with an empty manifest', async () => {
    const manifests = await loadPlugins({ paths: [path.join(FIXTURES, 'valid-operator.mjs')], disabled: ['fixture-op'] });
    expect(manifests[0].operators).toEqual([]);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeUndefined();
  });

  it('records duplicate registrations as manifest errors and keeps going', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = path.join(FIXTURES, 'valid-operator.mjs');
    const manifests = await loadPlugins({ paths: [p, p] });
    errSpy.mockRestore();
    expect(manifests[0].error).toBeUndefined();
    expect(manifests[1].error).toMatch(/already registered/);
  });

  it('silently skips missing directories', async () => {
    const manifests = await loadPlugins({ dirs: [path.join(FIXTURES, 'no-such-dir')] });
    expect(manifests).toEqual([]);
  });
});
