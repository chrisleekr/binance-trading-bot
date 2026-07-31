// Shared consumer pull/park protocol for the WS subscription iterators.
//
// The kline and mini-ticker streams (fake port + live fetcher) all expose the
// same single-consumer contract: pulls either drain a queued event, or park a
// resolver that the producer fan-out resolves on the next push. This is that
// iterator body, extracted so the four sites don't repeat it. The producer
// (queue.push / waiters.shift fan-out) stays inline at each site, as does the
// site-specific teardown, which is injected as `onReturn`.

/**
 * The subscriber slice this protocol reads. Each call site's own subscription
 * interface satisfies this structurally: a FIFO event `queue`, parked pull
 * `waiters`, and a `cancelled` flag the site's teardown flips.
 */
export interface AsyncQueueSub<T> {
  readonly queue: T[];
  readonly waiters: { readonly resolve: (v: IteratorResult<T>) => void }[];
  cancelled: boolean;
}

/**
 * Builds the async iterator for a subscription. `next()` runs the shared
 * three-branch pull: report done when cancelled, else yield a queued event,
 * else park a resolver for the next push. `return()` runs the site's
 * `onReturn` teardown before reporting done, so a parked pull the teardown
 * drains resolves before the iterator settles.
 */
export function queueAsyncIterable<T>(
  sub: AsyncQueueSub<T>,
  onReturn: () => void,
): AsyncIterableIterator<T> {
  return {
    async next(): Promise<IteratorResult<T>> {
      if (sub.cancelled) return { done: true, value: undefined };
      const head = sub.queue.shift();
      if (head !== undefined) return { done: false, value: head };
      return new Promise((resolve) => {
        sub.waiters.push({ resolve });
      });
    },
    async return(): Promise<IteratorResult<T>> {
      onReturn();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
