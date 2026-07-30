/**
 * Global semaphore to limit concurrent API calls across all evaluations
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A limit of 0 (or NaN, or a negative) is never a useful configuration — it is
 * a deadlock. release() clamps permits to the ceiling, so a 0 ceiling means the
 * queue can never drain and every caller hangs forever. updateGlobalSemaphoreLimit
 * is exported from the published package, so the clamp belongs here rather than
 * at any one call site.
 */
function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

class Semaphore {
  private permits: number;
  private limit: number;   // configured ceiling
  private inUse = 0;       // permits currently held by callers
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.limit = normalizeLimit(permits);
    this.permits = this.limit;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      this.inUse++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inUse++;
        resolve();
      });
    });
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    // Never hand back more than the ceiling MINUS what is still held: clamping
    // to the bare limit meant that after LOWERING it mid-flight, every
    // completion immediately re-issued a permit and concurrency never came
    // down. startEvaluation re-inits the semaphore on every run, so starting a
    // low-concurrency run beside a high-concurrency one kept the old ceiling.
    this.permits = Math.max(0, Math.min(this.limit - this.inUse, this.permits + 1));

    if (this.permits > 0 && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.permits--;
        next();
      }
    }
  }

  setPermits(newPermits: number): void {
    // Account for permits already held, otherwise re-initializing mid-run
    // re-issues them and the effective limit doubles.
    this.limit = normalizeLimit(newPermits);
    this.permits = Math.max(0, this.limit - this.inUse);

    // If we increased permits, release queued requests
    while (this.permits > 0 && this.queue.length > 0) {
      this.permits--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
  
  getLimit(): number {
    return this.limit;
  }

  getAvailable(): number {
    return this.permits;
  }
  
  getQueueLength(): number {
    return this.queue.length;
  }
}

// Global semaphore instance (default to 5, will be updated from settings)
let globalSemaphore = new Semaphore(5);

export function initGlobalSemaphore(limit: number): void {
  console.log(`[Semaphore] Initialized with limit: ${limit}`);
  globalSemaphore.setPermits(limit);
}

export function updateGlobalSemaphoreLimit(limit: number): void {
  console.log(`[Semaphore] Updated limit to: ${limit}`);
  globalSemaphore.setPermits(limit);
}

/**
 * Tracks whether the CURRENT async call chain already holds a permit.
 *
 * One logical API call must consume exactly one permit. It used to be possible
 * for a single call to acquire twice and then wait on itself forever:
 *   - a plugin adapter that calls withGlobalSemaphore itself,
 *   - a router plugin that delegates to a built-in adapter (which acquires),
 *   - a plugin subclassing a DUPLICATE copy of BaseProviderAdapter, which the
 *     `instanceof` guard in registry.ts cannot recognise (dual-package: the
 *     plugin resolves dist/ while the host runs src/).
 * acquire() has no timeout and callTimeoutMs is never reached, so the run hung
 * forever with no error — at ANY parallelLimit, as soon as that many calls were
 * in flight, which is the normal steady state.
 *
 * Re-entrancy fixes all three at the source, rather than trying to enumerate
 * the adapter shapes that need wrapping.
 */
const permitHeld = new AsyncLocalStorage<boolean>();

/** True when the caller is already inside a permit on this async chain. */
/** The configured concurrency cap, for callers that must bound their own overshoot. */
export function globalParallelLimit(): number {
  return globalSemaphore.getLimit();
}

export function holdsGlobalPermit(): boolean {
  return permitHeld.getStore() === true;
}

/**
 * Wrap an async API call with the global semaphore
 */
export async function withGlobalSemaphore<T>(
  fn: () => Promise<T>,
  label?: string
): Promise<T> {
  if (label) {
    // Three lines PER CALL. At ~39,000 calls that is 117,000 log lines, and in
    // the desktop every one is a separate IPC message to the renderer (see
    // electron/logger.ts). Only report when a call actually has to wait, which
    // is the only case the log was useful for.
    if (globalSemaphore.getAvailable() === 0) {
      console.log(`[Semaphore] ${label} waiting (queued: ${globalSemaphore.getQueueLength()})`);
    }
  }
  
  // Already holding one on this chain: run inline. Acquiring a second
  // permit for the same logical call is what deadlocked the run.
  if (permitHeld.getStore() === true) {
    return fn();
  }

  await globalSemaphore.acquire();

  try {
    return await permitHeld.run(true, fn);
  } finally {
    globalSemaphore.release();
  }
}

