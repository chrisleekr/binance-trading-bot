// Bounded concurrent fan-out.
//
// `fanOutBounded` runs `fn(item)` over `items` with at most `concurrency`
// promises in flight. Two error modes:
//
//   - `collect`: never throws. Every item is attempted. Failures land in
//     `result.errors` so the caller can log/continue. This is what the
//     cron handlers want — one bad profile must not abort the batch.
//
//   - `fail-fast`: rejects on the first error after letting in-flight work
//     settle. Items not yet started are skipped. The rejection carries
//     the original error.
//
// `result.ok` is in input order, with failed indices skipped (they appear
// in `result.errors`).

export interface FanOutOptions {
  /** Maximum concurrent in-flight promises. Must be >= 1. */
  readonly concurrency: number;
  /**
   * `collect` — never throws; runs every item; failures collected in
   * `result.errors`. Use for cron handlers where one bad item must not
   * abort the batch.
   *
   * `fail-fast` — reject on the first error after letting in-flight work
   * settle; remaining items are not started.
   */
  readonly onError: 'collect' | 'fail-fast';
}

export interface FanOutError<T> {
  readonly item: T;
  readonly error: unknown;
}

export interface FanOutResult<T, R> {
  /** Successful results in input order; failed indices skipped. */
  readonly ok: readonly R[];
  /** One entry per failed item; preserves the failing item and its error. */
  readonly errors: readonly FanOutError<T>[];
}

/**
 * Run `fn` over `items` with bounded concurrency.
 *
 * Throws on invalid `concurrency` (not a positive integer). Boot-time
 * misconfiguration must be loud, not silent.
 */
export const fanOutBounded = async <T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  opts: FanOutOptions,
): Promise<FanOutResult<T, R>> => {
  if (
    !Number.isFinite(opts.concurrency) ||
    opts.concurrency < 1 ||
    !Number.isInteger(opts.concurrency)
  ) {
    throw new Error(
      `fanOutBounded: concurrency must be a positive integer, got ${String(opts.concurrency)}`,
    );
  }
  if (items.length === 0) {
    return { ok: [], errors: [] };
  }

  // `ok` is built sparsely so we can preserve input order despite items
  // completing out-of-order. A final pass compacts to a dense array.
  const okSparse: (R | undefined)[] = new Array(items.length);
  const okFlags: boolean[] = new Array(items.length).fill(false);
  const errors: FanOutError<T>[] = [];
  let failFastError: unknown = null;
  let nextIndex = 0;

  const concurrency = Math.min(opts.concurrency, items.length);

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.onError === 'fail-fast' && failFastError !== null) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i] as T;
      try {
        const value = await fn(item);
        okSparse[i] = value;
        okFlags[i] = true;
      } catch (err) {
        if (opts.onError === 'fail-fast') {
          // Record the first error and stop pulling new items. In-flight
          // workers observe `failFastError` on their next loop turn and
          // bail; we await them all before rejecting so they don't run
          // after the surrounding scope has unwound.
          if (failFastError === null) failFastError = err;
          return;
        }
        errors.push({ item, error: err });
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  if (opts.onError === 'fail-fast' && failFastError !== null) {
    throw failFastError;
  }

  const ok: R[] = [];
  for (let i = 0; i < items.length; i++) {
    if (okFlags[i]) ok.push(okSparse[i] as R);
  }
  return { ok, errors };
};
