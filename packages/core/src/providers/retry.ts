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

/**
 * Attach the original error as `cause` when re-wrapping.
 *
 * Adapters that wrap a fetch failure into a friendlier Error MUST use this:
 * Node's fetch (undici) throws a bare `TypeError: fetch failed` and hangs the
 * real network code off `cause`, so dropping it made isRetryableError blind and
 * no transient failure was ever retried. Assigned rather than passed to the
 * Error constructor because this package targets ES2020.
 */
export function withCause<E extends Error>(error: E, cause: unknown): E {
  (error as any).cause = cause;
  return error;
}

/**
 * Read a `Retry-After` header into milliseconds.
 *
 * Accepts both documented forms: delta-seconds (`Retry-After: 2`) and an
 * HTTP-date. Returns undefined when absent or unparseable, so the caller falls
 * back to exponential backoff.
 */
export function retryAfterMsFrom(response: { headers?: { get(name: string): string | null } }): number | undefined {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Ceiling on the TOTAL time one logical call may spend honouring Retry-After.
 *
 * base.ts wraps withRetry INSIDE withGlobalSemaphore, so every second spent
 * waiting is a parallel slot held; callTimeoutMs bounds only the HTTP attempt
 * and timeLimitMs is checked at node boundaries, so nothing else aborts it.
 * `Retry-After: 3600` on a 503 is routine edge-network behaviour and used to
 * stall a slot for three minutes across the retries.
 *
 * A single budget, deliberately: a separate per-sleep clamp made this a hard
 * cliff at 61s and left both its own clauses dead code.
 */
const MAX_RETRY_AFTER_TOTAL_MS = 120_000;

export function isRetryableError(error: any): boolean {
  // Retry on network errors or specific HTTP status codes
  if (error instanceof RetryableError) return true;

  // A 200 whose BODY is not JSON — a Cloudflare HTML error page, an SSE stream
  // sent to a non-stream request — surfaces as a SyntaxError from
  // response.json(). It carries no status and no cause.code, so it was
  // classified non-retryable: the transient gateway blip killed the node on the
  // first try, while a merely empty JSON body got four attempts. The worse
  // failure failed permanently. Match only the shape response parsing produces,
  // so a genuine programming SyntaxError still fails fast.
  if (error instanceof SyntaxError && /is not valid JSON|Unexpected (token|end of JSON)/i.test(error.message ?? '')) {
    return true;
  }
  
  const retryableStatusCodes = [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ];
  
  const statusCode = error.status ?? error.statusCode;
  if (statusCode) {
    // An explicit HTTP status is authoritative in BOTH directions. Falling
    // through to the network-code walk let a hard 400 whose cause happened to
    // carry ECONNRESET burn four attempts on a request that can never succeed.
    return retryableStatusCodes.includes(statusCode);
  }

  // Network errors. (see withCause below)
  //
  // Node's fetch (undici) does NOT put the code on the error — it throws
  // `TypeError: fetch failed` and hangs the real cause off `error.cause`. Only
  // checking error.code meant NO transient network failure was ever retried:
  // one reset socket on one sample discarded every already-paid-for test
  // result on that candidate and marked the node failed. Walk the cause chain,
  // since adapters may wrap the error again.
  const RETRYABLE_NETWORK_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]);
  for (let node: any = error, depth = 0; node && depth < 5; node = node.cause, depth++) {
    if (typeof node.code === 'string' && RETRYABLE_NETWORK_CODES.has(node.code)) {
      return true;
    }
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
  let retryAfterSpent = 0;
  
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
        // Honour Retry-After when the provider sent one. Backoff alone put all
        // four attempts INSIDE the window the provider asked us to wait out —
        // guaranteed 429s, and on providers that extend the window under
        // continued hammering it makes the rate limit worse. Capped so a
        // hostile or mistaken header cannot stall a run indefinitely.
        const askedMs = Number((error as any)?.retryAfterMs);
        const honouring = Number.isFinite(askedMs) && askedMs > 0;
        // No per-sleep clamp. Clamping asked-for time and THEN comparing the
        // clamped value to the budget made both clauses dead and put a hard
        // cliff at 61s: `Retry-After: 60` slept and retried, `Retry-After: 61`
        // failed in 0ms regardless of the configured retries. A minute or two
        // is an ordinary value from an edge network. Honour what was asked when
        // the budget can cover it; refuse outright when it cannot, because
        // waiting LESS than asked is a guaranteed repeat failure.
        let delay = honouring ? askedMs : calculateDelay(attempt, opts);

        if (honouring) {
          // Waiting LESS than the provider asked is worse than not retrying:
          // it is a guaranteed repeat failure, and providers that extend the
          // window under continued hammering make the rate limit worse. So
          // when the remaining budget cannot cover the wait, give up now.
          // Compare what the provider ASKED for, not the clamped sleep. Testing
          // the clamped value meant `Retry-After: 3600` produced delay = 60000,
          // `60000 > 60000` was false, and the call still stalled a parallel
          // slot for a full 60s — while waiting far less than asked, which the
          // rule right here says is a guaranteed repeat failure.
          const remaining = MAX_RETRY_AFTER_TOTAL_MS - retryAfterSpent;
          if (askedMs > remaining) {
            console.warn(
              `Provider asked for ${Math.round(askedMs / 1000)}s before retrying and this call has ` +
              `already waited ${Math.round(retryAfterSpent / 1000)}s — giving up rather than holding a ` +
              `parallel slot, or retrying early and making the rate limit worse.`,
            );
            throw error;
          }
          retryAfterSpent += delay;
        }

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

