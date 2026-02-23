import { describe, it, expect, beforeEach } from 'vitest';
import { initGlobalSemaphore, withGlobalSemaphore, updateGlobalSemaphoreLimit } from '../../../electron/engine/semaphore';

describe('semaphore', () => {
  beforeEach(() => {
    initGlobalSemaphore(3);
  });

  it('allows execution within semaphore limit', async () => {
    const result = await withGlobalSemaphore(async () => 'done');
    expect(result).toBe('done');
  });

  it('returns the value from the wrapped function', async () => {
    const result = await withGlobalSemaphore(async () => 42);
    expect(result).toBe(42);
  });

  it('enforces concurrency limit', async () => {
    initGlobalSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 50));
      concurrent--;
      return true;
    };

    const promises = Array.from({ length: 6 }, () => withGlobalSemaphore(task));
    await Promise.all(promises);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('releases permit even when function throws', async () => {
    initGlobalSemaphore(1);

    try {
      await withGlobalSemaphore(async () => {
        throw new Error('test error');
      });
    } catch {
      // expected
    }

    // Should still be able to acquire after error
    const result = await withGlobalSemaphore(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('processes queued tasks in order', async () => {
    initGlobalSemaphore(1);
    const order: number[] = [];

    const makeTask = (id: number) => withGlobalSemaphore(async () => {
      order.push(id);
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    await Promise.all([makeTask(1), makeTask(2), makeTask(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('updateGlobalSemaphoreLimit changes the limit', async () => {
    initGlobalSemaphore(1);
    updateGlobalSemaphoreLimit(3);

    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 50));
      concurrent--;
    };

    const promises = Array.from({ length: 5 }, () => withGlobalSemaphore(task));
    await Promise.all(promises);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
