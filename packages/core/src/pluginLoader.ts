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
import { registerOperator, registerProvider, unregisterOperator, unregisterProvider } from './registry.js';

export interface LoadPluginsOptions {
  dirs?: string[];
  paths?: string[];
  disabled?: string[];
}

function discover(dir: string): string[] {
  // A typo'd path used to load nothing in silence, and the failure surfaced
  // much later as an unrelated "Unknown provider" error.
  if (!fs.existsSync(dir)) {
    console.warn(`[Plugins] ${dir} does not exist — no plugins loaded from it.`);
    return [];
  }
  // docs/plugins.md says a plugin may be a single .mjs FILE, but readdirSync on
  // one threw a raw ENOTDIR out of the whole CLI — breaking the documented
  // promise that a bad plugin "contributes nothing" and the host keeps running.
  // The config-file route already handled file-vs-directory; --plugins did not.
  if (fs.statSync(dir).isFile()) {
    return /\.(mjs|js)$/.test(dir) ? [dir] : [];
  }
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

/** How long a plugin's module body may take to evaluate before we give up. */
const IMPORT_TIMEOUT_MS = 10_000;

/**
 * A plugin's top-level code runs during import. A module that never settles —
 * the realistic case being a provider plugin that pings a local server on a
 * dead socket — left loadPlugins pending forever. In the desktop app that runs
 * before createWindow(), so the user got no window, no error, and no way to
 * reach Settings to disable the offending plugin. A throw was already handled;
 * a hang was not.
 */
async function importWithTimeout(file: string): Promise<any> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    import(pathToFileURL(file).href),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`plugin did not finish loading within ${IMPORT_TIMEOUT_MS}ms (top-level code may be blocking)`)),
        IMPORT_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<PluginManifest[]> {
  const files = [
    ...(opts.dirs ?? []).flatMap(discover),
    ...(opts.paths ?? []).map(p => path.resolve(p)),
  ];
  const disabled = new Set(opts.disabled ?? []);
  const manifests: PluginManifest[] = [];
  const seenNames = new Map<string, string>();

  for (const file of files) {
    const manifest: PluginManifest = { name: path.basename(file), source: file, operators: [], providers: [] };
    manifests.push(manifest);
    try {
      const mod = await importWithTimeout(file);
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

      // Two plugins sharing a name both loaded, and the Settings toggle (keyed
      // by name) then disabled or enabled both at once.
      const firstSeen = seenNames.get(plugin.name);
      if (firstSeen) {
        throw new Error(`plugin name '${plugin.name}' is already registered (loaded from ${firstSeen})`);
      }

      if (plugin.operators !== undefined && !Array.isArray(plugin.operators)) throw new Error('"operators" must be an array');
      if (plugin.providers !== undefined && !Array.isArray(plugin.providers)) throw new Error('"providers" must be an array');

      // Validate the WHOLE plugin before registering any of it. Registering as
      // we validated left a rejected plugin half-live: the manifest reported an
      // error while its earlier operators stayed callable, contradicting the
      // "contributes nothing" contract in docs/plugins.md.
      for (const op of plugin.operators ?? []) validateOperator(op);
      for (const prov of plugin.providers ?? []) validateProvider(prov);

      for (const op of plugin.operators ?? []) {
        registerOperator(op);
        manifest.operators.push(op.name);
      }
      for (const prov of plugin.providers ?? []) {
        registerProvider(prov);
        manifest.providers.push(prov.adapter.name);
      }
      seenNames.set(plugin.name, file);
      console.log(`[Plugins] Loaded '${manifest.name}' (${manifest.operators.length} operators, ${manifest.providers.length} providers) from ${file}`);
    } catch (error) {
      // Roll back whatever this plugin managed to register before it failed —
      // registerOperator/registerProvider still throw on name collisions and
      // invalid model prices, which pre-validation cannot see.
      for (const name of manifest.operators) unregisterOperator(name);
      for (const id of manifest.providers) unregisterProvider(id);
      manifest.error = error instanceof Error ? error.message : String(error);
      manifest.operators = [];
      manifest.providers = [];
      console.error(`[Plugins] Failed to load ${file}: ${manifest.error}`);
    }
  }
  return manifests;
}
