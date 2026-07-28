/**
 * CLI plugin wiring: resolves config-declared plugin paths relative to the
 * config file, merges --plugins directories, loads, and reports errors to
 * stderr without aborting the run.
 */
import path from 'path';
import { loadPlugins, type PluginManifest } from '@promptengine/core';

export interface CliPluginOptions {
  configDir: string;
  configPlugins: string[];
  flagDirs: string[];
}

export async function loadCliPlugins(opts: CliPluginOptions): Promise<PluginManifest[]> {
  const paths = opts.configPlugins.map(p => path.resolve(opts.configDir, p));
  const manifests = await loadPlugins({ dirs: opts.flagDirs, paths });
  for (const m of manifests) {
    if (m.error) {
      console.error(`[Plugins] ${m.source}: ${m.error}`);
    }
  }
  return manifests;
}
