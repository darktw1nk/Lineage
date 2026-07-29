/**
 * Global semaphore to limit concurrent API calls across all evaluations
 */

class Semaphore {
  private permits: number;
  private limit: number;   // configured ceiling
  private inUse = 0;       // permits currently held by callers
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.limit = permits;
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
    // Never hand back more than the ceiling: an unconditional ++ combined with
    // a re-init while calls are in flight permanently inflates concurrency.
    this.permits = Math.min(this.limit, this.permits + 1);

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
    this.limit = newPermits;
    this.permits = Math.max(0, newPermits - this.inUse);

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
    console.log(`[Semaphore] Acquiring permit for: ${label} (available: ${globalSemaphore.getAvailable()}, queued: ${globalSemaphore.getQueueLength()})`);
  }
  
  await globalSemaphore.acquire();
  
  if (label) {
    console.log(`[Semaphore] Permit acquired for: ${label}`);
  }
  
  try {
    const result = await fn();
    return result;
  } finally {
    globalSemaphore.release();
    
    if (label) {
      console.log(`[Semaphore] Permit released for: ${label} (available: ${globalSemaphore.getAvailable()}, queued: ${globalSemaphore.getQueueLength()})`);
    }
  }
}

