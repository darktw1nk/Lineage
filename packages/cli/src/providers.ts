/**
 * Provider capability lookups the CLI's preflights need.
 */
import { getProviderAdapter } from '@voxor/lineage-core';
import type { Provider } from '@voxor/lineage-core';

/**
 * Does this provider need an API key before a run may start?
 *
 * Only adapters that declare `requiresApiKey` do. The five built-ins are built
 * on BaseProviderAdapter, which sets it; a plugin provider opts in.
 *
 * Defaulting to "yes" for everything refused to start any run using the shipped
 * Ollama example — a local server whose own header says "No API key needed" —
 * with `No API key found for provider: ollama`, and pointed the user at an
 * `ollamaKey` config field that does nothing.
 *
 * An unregistered provider answers `false`: the caller has a separate, better
 * error for that ("provider not registered — load the plugin"), and reporting a
 * missing key would name the wrong problem.
 */
export function providerRequiresApiKey(provider: Provider): boolean {
  try {
    return getProviderAdapter(provider)?.requiresApiKey === true;
  } catch {
    return false;
  }
}
