/**
 * CLI plugin wiring: resolves config-declared plugin paths relative to the
 * config file, merges --plugins directories, loads, and reports errors to
 * stderr without aborting the run.
 */
import fs from 'fs';
import path from 'path';
import { loadPlugins, type PluginManifest } from '@voxor/lineage-core';

export interface CliPluginOptions {
  configDir: string;
  configPlugins: string[];
  flagDirs: string[];
}

export async function loadCliPlugins(opts: CliPluginOptions): Promise<PluginManifest[]> {
  // A config entry may name a FILE or a DIRECTORY — docs/cli.md documents
  // `["./my-operator.mjs", "./plugin-dir"]` and docs/plugins.md says a plugin
  // may be "a folder with index.mjs". Sending every entry to `paths` meant a
  // directory was imported as a module, so it failed with
  // "Cannot find module …\index.json" — naming a file the user never created —
  // and the run then died later with an unrelated "Unknown provider".
  const paths: string[] = [];
  const dirs: string[] = [...opts.flagDirs];
  for (const entry of opts.configPlugins) {
    const resolved = path.resolve(opts.configDir, entry);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
      // Missing: treat as a file so the loader reports the path the user wrote.
    }
    (isDirectory ? dirs : paths).push(resolved);
  }

  const manifests = await loadPlugins({ dirs, paths });
  for (const m of manifests) {
    if (m.error) {
      console.error(`[Plugins] ${m.source}: ${m.error}`);
    }
  }
  return manifests;
}
