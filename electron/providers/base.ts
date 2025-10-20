import type { Provider, ProviderAdapter } from '../../src/types/index.js';
import { getModelCost } from './costs.js';

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract name: Provider;
  
  abstract estimateTokens(input: string): { prompt: number; completion?: number };
  
  abstract callAPI(opts: {
    apiKey: string;
    model: string;
    prompt: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }>;
  
  async call(opts: {
    model: string;
    prompt: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    usd: number;
    rawPath?: string;
  }> {
    // Get API key from environment or keytar
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(`No API key found for provider: ${this.name}`);
    }
    
    const startTime = Date.now();
    
    try {
      const result = await this.callAPI({
        apiKey,
        ...opts,
      });
      
      const latencyMs = Date.now() - startTime;
      
      // Calculate cost
      const cost = await getModelCost({
        provider: this.name,
        model: opts.model,
      });
      
      const usd = cost
        ? (result.promptTokens / 1000) * cost.promptUSDper1k +
          (result.completionTokens / 1000) * cost.completionUSDper1k
        : 0;
      
      return {
        ...result,
        latencyMs,
        usd,
      };
    } catch (error) {
      throw new Error(`Provider ${this.name} call failed: ${error}`);
    }
  }
  
  protected abstract getApiKey(): Promise<string | null>;
}

