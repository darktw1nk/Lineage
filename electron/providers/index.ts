import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import type { Provider, ProviderAdapter } from '../../src/types/index.js';

const adapters: Record<Provider, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
};

export function getProviderAdapter(provider: Provider): ProviderAdapter {
  return adapters[provider];
}

