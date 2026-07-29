/**
 * Global semaphore to limit concurrent API calls across all evaluations
 */

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
  
  await globalSemaphore.acquire();

  try {
    const result = await fn();
    return result;
  } finally {
    globalSemaphore.release();
  }
}

