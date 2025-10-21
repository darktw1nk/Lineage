/**
 * Global semaphore to limit concurrent API calls across all evaluations
 */

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }
  
  release(): void {
    this.permits++;
    
    const next = this.queue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
  
  setPermits(newPermits: number): void {
    this.permits = newPermits;
    
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

