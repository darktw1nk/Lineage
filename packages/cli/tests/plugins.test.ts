import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCliPlugins } from '../src/plugins.js';
import { getOperator, resetRegistry } from '@voxor/lineage-core';

const CORE_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'core', 'tests', 'fixtures', 'plugins',
);

beforeEach(() => resetRegistry());

describe('loadCliPlugins', () => {
  it('resolves config-relative paths and loads them', async () => {
    const manifests = await loadCliPlugins({
      configDir: CORE_FIXTURES,
      configPlugins: ['./valid-operator.mjs'],
      flagDirs: [],
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0].error).toBeUndefined();
    expect(getOperator('reverse-prompt')).toBeDefined();
  });

  it('merges --plugins directories and reports errors without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifests = await loadCliPlugins({ configDir: '.', configPlugins: [], flagDirs: [CORE_FIXTURES] });
    errSpy.mockRestore();
    expect(manifests.length).toBeGreaterThanOrEqual(5); // all fixture modules discovered
    expect(manifests.some(m => m.error)).toBe(true);    // broken.mjs reported, not thrown
  });
});
