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
  
  const statusCode = error.status ?? error.statusCode;
  if (statusCode && retryableStatusCodes.includes(statusCode)) {
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
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (!isRetryableError(error)) {
        // Non-retryable error, throw immediately
        throw error;
      }

      if (attempt < opts.maxRetries) {
        const delay = calculateDelay(attempt, opts);
        console.log(`Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  // All retries exhausted
  throw lastError!;
}

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * fetch with a hard per-attempt timeout. A hung request is aborted and rethrown
 * as RetryableError(408) so withRetry gives it a fresh attempt (and a fresh
 * timeout budget); repeated timeouts exhaust retries and fail the call, freeing
 * the global semaphore slot instead of pinning it forever.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // NOTE: a caller-supplied init.signal would be overridden here. No current
    // caller passes one; if that changes, combine with AbortSignal.any().
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Read the FULL body under the timer: a slow-drip body (bytes trickling in
    // below undici's idle threshold) would otherwise hang past the timeout.
    // Reconstructing the Response keeps callers' .json()/.text()/.ok working
    // unchanged — they now read from memory. Guarded by instanceof so plain
    // test doubles (legacy stubs without .text) pass through untouched; real
    // fetch always returns a Response, so production is always protected.
    if (res instanceof Response) {
      const body = await res.text();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  } catch (error: any) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new RetryableError(`Request timed out after ${timeoutMs}ms`, 408);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

