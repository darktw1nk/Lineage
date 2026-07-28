import type { Provider, ProviderAdapter } from '../types.js';
import { getModelCost } from './costs.js';
import { withGlobalSemaphore } from '../engine/semaphore.js';

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract name: Provider;
  
  abstract estimateTokens(input: string): { prompt: number; completion?: number };
  
  abstract callAPI(opts: {
    apiKey: string;
    model: string;
    prompt: string;
    system?: string;
    temperature: number;
    seed?: number;
    maxTokens?: number;
    timeoutMs?: number;
    providerOptions?: Record<string, any>;
    images?: Array<{ base64: string; mimeType: string; detail?: 'auto' | 'low' | 'high' }>;
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
    timeoutMs?: number;
    providerOptions?: Record<string, any>;
    images?: Array<{ base64: string; mimeType: string; detail?: 'auto' | 'low' | 'high' }>;
  }): Promise<{
    output: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    usd: number;
  }> {
    // Wrap ALL API calls with global semaphore
    return withGlobalSemaphore(async () => {
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
        
        console.log(`[BaseAdapter] Cost entry for ${this.name}/${opts.model}:`, cost);
        
        const usd = cost
          ? (result.promptTokens / 1000) * cost.promptUSDper1k +
            (result.completionTokens / 1000) * cost.completionUSDper1k
          : 0;
        
        console.log(`[BaseAdapter] Calculated USD: ${usd} (prompt: ${result.promptTokens}, completion: ${result.completionTokens})`);
        
        return {
          ...result,
          latencyMs,
          usd,
        };
      } catch (error) {
        throw new Error(`Provider ${this.name} call failed: ${error}`);
      }
    }, `${this.name}/${opts.model}`);
  }
  
  protected abstract getApiKey(): Promise<string | null>;
}

