import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenRouterAdapter } from './openrouter.js';
import { GroqAdapter } from './groq.js';
import type { Provider, ProviderAdapter } from '../types.js';

const adapters: Record<Provider, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  openrouter: new OpenRouterAdapter(),
  groq: new GroqAdapter(),
};

export function getProviderAdapter(provider: Provider): ProviderAdapter {
  return adapters[provider];
}

