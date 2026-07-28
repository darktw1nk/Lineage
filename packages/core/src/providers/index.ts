import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenRouterAdapter } from './openrouter.js';
import { GroqAdapter } from './groq.js';
import type { Provider, ProviderAdapter } from '../types.js';

import { getRegisteredProviderAdapter } from '../registry.js';

const adapters: Record<string, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  openrouter: new OpenRouterAdapter(),
  groq: new GroqAdapter(),
};

export function getProviderAdapter(provider: Provider): ProviderAdapter {
  const builtin = adapters[provider];
  if (builtin) return builtin;
  const plugin = getRegisteredProviderAdapter(provider);
  if (plugin) return plugin;
  throw new Error(`Unknown provider: ${provider}`);
}

