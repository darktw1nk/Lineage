// Rate limiter for API requests (RPM/TPM)

export interface RateLimitConfig {
  rpm?: number; // Requests per minute
  tpm?: number; // Tokens per minute
}

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export class RateLimiter {
  private provider: string;
  private config: RateLimitConfig;
  private requests: RequestRecord[] = [];
  
  constructor(provider: string, config: RateLimitConfig) {
    this.provider = provider;
    this.config = config;
  }
  
  private cleanOldRequests(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.requests = this.requests.filter(r => r.timestamp > oneMinuteAgo);
  }
  
  private getRequestsInLastMinute(): number {
    this.cleanOldRequests();
    return this.requests.length;
  }
  
  private getTokensInLastMinute(): number {
    this.cleanOldRequests();
    return this.requests.reduce((sum, r) => sum + r.tokens, 0);
  }
  
  async waitIfNeeded(estimatedTokens: number = 1000): Promise<void> {
    this.cleanOldRequests();
    
    // Check RPM limit
    if (this.config.rpm) {
      const currentRPM = this.getRequestsInLastMinute();
      if (currentRPM >= this.config.rpm) {
        // Find oldest request
        const oldestRequest = this.requests[0];
        if (oldestRequest) {
          const waitTime = 60000 - (Date.now() - oldestRequest.timestamp) + 100; // +100ms buffer
          if (waitTime > 0) {
            console.log(`Rate limit: waiting ${waitTime}ms for ${this.provider} (RPM: ${currentRPM}/${this.config.rpm})`);
            await this.sleep(waitTime);
            return this.waitIfNeeded(estimatedTokens); // Retry
          }
        }
      }
    }
    
    // Check TPM limit
    if (this.config.tpm) {
      const currentTPM = this.getTokensInLastMinute();
      if (currentTPM + estimatedTokens > this.config.tpm) {
        // Find oldest request that would bring us under limit
        let tokensToFree = (currentTPM + estimatedTokens) - this.config.tpm;
        let oldestTimestamp = Date.now();
        
        for (const req of this.requests) {
          if (tokensToFree <= 0) break;
          tokensToFree -= req.tokens;
          oldestTimestamp = req.timestamp;
        }
        
        const waitTime = 60000 - (Date.now() - oldestTimestamp) + 100; // +100ms buffer
        if (waitTime > 0) {
          console.log(`Rate limit: waiting ${waitTime}ms for ${this.provider} (TPM: ${currentTPM}/${this.config.tpm})`);
          await this.sleep(waitTime);
          return this.waitIfNeeded(estimatedTokens); // Retry
        }
      }
    }
  }
  
  recordRequest(tokens: number): void {
    this.requests.push({
      timestamp: Date.now(),
      tokens,
    });
    this.cleanOldRequests();
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Global rate limiters per provider
const rateLimiters = new Map<string, RateLimiter>();

export function getRateLimiter(provider: string, config: RateLimitConfig): RateLimiter {
  let limiter = rateLimiters.get(provider);
  if (!limiter) {
    limiter = new RateLimiter(provider, config);
    rateLimiters.set(provider, limiter);
  }
  return limiter;
}

