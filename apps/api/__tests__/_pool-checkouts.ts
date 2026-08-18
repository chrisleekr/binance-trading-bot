import type { Pool, PoolClient } from 'pg';

/** What one recording window observed about the api's use of its shared pool. */
export interface PoolCheckoutRecord<T> {
  /** Highest number of connections checked out at the same moment during the window. This is the property that caps the blast radius: against a pool of ten, a route that peaks at seven can be emptied by two concurrent requests. */
  readonly peak: number;
  /** Every statement issued on a connection checked out during the window, in issue order, as SQL text. */
  readonly statements: string[];
  /** Whatever `fn` resolved to, so a caller can assert on the response as well as on the pool. */
  readonly result: T;
}

/**
 * Runs `fn` while recording the pool's checkout concurrency and every statement issued on a checked-out connection.
 *
 * Recording is installed from pg-pool's `acquire` event, which fires BEFORE the client is handed to the caller, so no query issued inside `fn` can slip past the wrapper. The wrapper is an own property over the prototype method and is deleted on release, restoring the original exactly rather than leaving a copy on every pooled client for the rest of the suite.
 *
 * @param pool - The pool the app under test is wired to, normally `fx.di.pool`; the listeners are attached and removed around `fn` so other tests in the file are unaffected.
 * @param fn - The work to observe, typically one `app.request(...)`. Its resolved value is returned untouched as `result`.
 * @returns The peak concurrent checkout count, the statements seen, and `fn`'s own result.
 */
export async function recordPoolCheckouts<T>(
  pool: Pool,
  fn: () => Promise<T>,
): Promise<PoolCheckoutRecord<T>> {
  let live = 0;
  let peak = 0;
  const statements: string[] = [];
  const patched = new Set<PoolClient>();
  const checkedOut = new Set<PoolClient>();

  const unpatch = (client: PoolClient): void => {
    delete (client as { query?: unknown }).query;
  };

  const onAcquire = (client: PoolClient): void => {
    checkedOut.add(client);
    live += 1;
    peak = Math.max(peak, live);
    if (patched.has(client)) return;
    patched.add(client);
    const original = client.query as (...args: unknown[]) => unknown;
    Object.defineProperty(client, 'query', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const first = args[0];
        statements.push(
          typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''),
        );
        return original.apply(client, args);
      },
    });
  };

  const onRelease = (_err: Error | undefined, client: PoolClient): void => {
    // Only releases matching a checkout this window saw. A client already held when the listeners attached would otherwise drive the counter negative, and `peak` would under-report — the caller would then fail, or pass, on bookkeeping rather than on the property.
    if (!checkedOut.delete(client)) return;
    live -= 1;
    if (patched.delete(client)) unpatch(client);
  };

  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await fn();
    return { peak, statements, result };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
    for (const client of patched) unpatch(client);
    patched.clear();
    checkedOut.clear();
  }
}
