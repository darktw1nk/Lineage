/**
 * File-based plugin loader. A plugin is a JS module (.mjs/.js, or a directory
 * containing index.mjs/index.js) whose default export follows the contract in
 * docs/plugins.md. Per-module failures land in the returned manifests — this
 * function never throws for a bad plugin.
 *
 * Trust model: plugins are arbitrary local JavaScript executed with full
 * process privileges — the same trust level as an npm dependency.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PluginManifest, OperatorPlugin, ProviderPlugin } from './types.js';
import { registerOperator, registerProvider } from './registry.js';

export interface LoadPluginsOptions {
  dirs?: string[];
  paths?: string[];
  disabled?: string[];
}

function discover(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      found.push(full);
    } else if (entry.isDirectory()) {
      for (const index of ['index.mjs', 'index.js']) {
        const candidate = path.join(full, index);
        if (fs.existsSync(candidate)) { found.push(candidate); break; }
      }
    }
  }
  return found;
}

function validateOperator(op: any): asserts op is OperatorPlugin {
  if (!op || typeof op.name !== 'string' || !op.name) throw new Error('operator entry missing string "name"');
  if (op.parents !== 1 && op.parents !== 2) throw new Error(`operator '${op.name}' must declare parents: 1 or 2`);
  if (typeof op.apply !== 'function') throw new Error(`operator '${op.name}' missing apply() function`);
}

function validateProvider(p: any): asserts p is ProviderPlugin {
  if (!p?.adapter || typeof p.adapter.name !== 'string' || !p.adapter.name) throw new Error('provider entry missing adapter with string "name"');
  if (typeof p.adapter.call !== 'function') throw new Error(`provider '${p.adapter.name}' adapter missing call() function`);
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginManifest[]> {
  const files = [
    ...(opts.dirs ?? []).flatMap(discover),
    ...(opts.paths ?? []).map(p => path.resolve(p)),
  ];
  const disabled = new Set(opts.disabled ?? []);
  const manifests: PluginManifest[] = [];

  for (const file of files) {
    const manifest: PluginManifest = { name: path.basename(file), source: file, operators: [], providers: [] };
    manifests.push(manifest);
    try {
      const mod = await import(pathToFileURL(file).href);
      const plugin = mod.default;
      if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string' || !plugin.name) {
        throw new Error('default export must be an object with a string "name"');
      }
      manifest.name = plugin.name;
      manifest.version = plugin.version;

      if (disabled.has(plugin.name)) {
        console.log(`[Plugins] '${plugin.name}' is disabled — skipping`);
        continue;
      }

      if (plugin.operators !== undefined && !Array.isArray(plugin.operators)) throw new Error('"operators" must be an array');
      if (plugin.providers !== undefined && !Array.isArray(plugin.providers)) throw new Error('"providers" must be an array');

      for (const op of plugin.operators ?? []) {
        validateOperator(op);
        registerOperator(op);
        manifest.operators.push(op.name);
      }
      for (const prov of plugin.providers ?? []) {
        validateProvider(prov);
        registerProvider(prov);
        manifest.providers.push(prov.adapter.name);
      }
      console.log(`[Plugins] Loaded '${manifest.name}' (${manifest.operators.length} operators, ${manifest.providers.length} providers) from ${file}`);
    } catch (error) {
      manifest.error = error instanceof Error ? error.message : String(error);
      console.error(`[Plugins] Failed to load ${file}: ${manifest.error}`);
    }
  }
  return manifests;
}
