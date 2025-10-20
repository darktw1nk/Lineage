// Retry logic with exponential backoff and jitter

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export class RetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'RetryableError';
  }
}

export function isRetryableError(error: any): boolean {
  // Retry on network errors or specific HTTP status codes
  if (error instanceof RetryableError) return true;
  
  const retryableStatusCodes = [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ];
  
  if (error.status && retryableStatusCodes.includes(error.status)) {
    return true;
  }
  
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true;
  }
  
  return false;
}

function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = Math.min(
    options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt),
    options.maxDelayMs
  );
  
  // Add jitter to prevent thundering herd
  const jitter = exponentialDelay * options.jitterFactor * (Math.random() * 2 - 1);
  
  return Math.floor(exponentialDelay + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error;
  
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      if (!isRetryableError(error)) {
        // Non-retryable error, throw immediately
        throw error;
      }
      
      if (attempt < opts.maxRetries - 1) {
        const delay = calculateDelay(attempt, opts);
        console.log(`Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  // All retries exhausted
  throw lastError!;
}

