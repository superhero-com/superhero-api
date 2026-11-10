/**
 * Runs `mapper` over `items` with at most `concurrency` in flight at once,
 * preserving result order. A fixed-size worker pool pulls the next index
 * as each one finishes, rather than chunking into fixed batches, so a slow
 * item never idles the other workers.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Returns a runner that lets at most `limit` tasks run at once across every
 * caller sharing it. The others wait in FIFO order.
 */
export function createConcurrencyLimiter(limit: number) {
  const slots = Math.max(limit, 1);
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < slots) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };

  // Hand the slot straight to the next waiter: freeing it first would let a
  // new caller take it before the woken waiter resumes.
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
