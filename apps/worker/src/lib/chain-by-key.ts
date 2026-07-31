// Serial-by-key in-process executor.
//
// Wraps async work so concurrent calls with the same key never overlap,
// while different keys run independently. The chain is a Map<string,
// Promise>; the next call for a key is appended to that key's tail.
//
// This is the core of v1.0's lock-free single-replica guarantee: BullMQ
// concurrency 25 may pop multiple jobs for the same (profileId, symbol)
// in quick succession, and chainByKey serialises them without any
// distributed lock.

export interface ChainByKey {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  size(): number;
}

export const createChainByKey = (): ChainByKey => {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      const cleanup = next.finally(() => {
        if (tails.get(key) === cleanup) tails.delete(key);
      });
      // The stored chain exists only to serialise the next call; the
      // caller observes the real error via `next`. Swallow the stored
      // branch's rejection so a throw inside `fn` doesn't surface as
      // an unhandled rejection from the Map's reference. Surfaced by
      // #261 once `mutateSymbolState` started throwing on migration
      // failure inside `fill-adopter`.
      void cleanup.catch(() => undefined);
      tails.set(key, cleanup);
      return next;
    },
    size: () => tails.size,
  };
};
