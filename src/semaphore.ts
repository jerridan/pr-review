// A semaphore that bounds how many tasks run at once. Each SDK query runs
// as its own Claude Code process, so the run bounds them all with one
// semaphore.

export type Semaphore = <T>(task: () => Promise<T>) => Promise<T>;

/** Make a semaphore that runs at most "limit" tasks at once, in arrival order. */
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`The semaphore limit must be an integer of 1 or more, not ${limit}.`);
  }
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      // The slot goes to the next task directly, so "active" stays the same.
      next();
    } else {
      active -= 1;
    }
  };

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
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
