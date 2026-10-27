export type KeyedLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** Runs callbacks that share a key one at a time, in call order; different keys run concurrently. */
export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return async (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    tails.set(key, run);
    try {
      return await run;
    } finally {
      if (tails.get(key) === run) tails.delete(key);
    }
  };
}
