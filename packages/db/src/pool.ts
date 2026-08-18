import { Pool, type PoolConfig } from 'pg';

// v1.0 connects directly to Postgres via the `pg` driver.
// Production deferral: PgBouncer / PgCat (transaction pooling) becomes worthwhile
// only beyond ~5 worker replicas; v1.0 ships single-replica so direct pooling is
// sufficient. When that day comes, point `connectionString` at the pooler URL;
// no other code changes needed.
export type PoolKind = 'api' | 'worker' | 'admin';

export interface CreatePoolOptions {
  kind: PoolKind;
  connectionString: string;
}

/** Documented in ENV_CATALOGUE under `*_DB_POOL_MAX`; the two are pinned by test. */
const DEFAULT_MAX: Record<PoolKind, number> = {
  api: 10,
  worker: 25,
  admin: 2,
};

/**
 * How long a checkout may go unserved before it fails, for every pool kind.
 *
 * Unset, pg-pool queues a checkout with NO timer at all, so once `max` connections are held every later checkout on every route waits forever: no error, no log line, no request timeout of its own. That is not a slow page, it is the process going dark while still answering its health check.
 *
 * One `connectionTimeoutMillis` arms BOTH of pg-pool's timers — the wait for a busy pool to free a connection, and the TCP/handshake of a brand-new connection — so the number cannot be tuned for checkout pressure alone; it also has to leave room for a cold connect to a healthy database, which is why it is seconds rather than the few hundred milliseconds a queue wait deserves.
 *
 * One value serves all three kinds because only `api` ever queues: `worker` fans out per job against 25 connections, `admin` is `max: 2` with no concurrent fan-out, and migrations do not touch a pool at all (`migrate()` opens a bare `Client`). Per-kind numbers would be three knobs where two have no load to tune against.
 *
 * A constant, not an environment variable: the failure it prevents is unbounded queueing, and an operator who can set this can also set it to a value that reintroduces the hang.
 */
export const POOL_CHECKOUT_TIMEOUT_MS = 5_000;

/** pg-pool's wait-queue rejection: raised when the pool was full and no connection came free in time. */
const QUEUE_WAIT_MESSAGE = 'timeout exceeded when trying to connect';

/** pg-pool's cold-connect rejection: raised when establishing a NEW connection outlasted the deadline. Its `cause` carries the driver's own 'Connection terminated unexpectedly'. */
const COLD_CONNECT_MESSAGE = 'Connection terminated due to connection timeout';

/** Bound on how far the cause chain is walked, so a self-referencing `cause` cannot spin forever. */
const MAX_CAUSE_DEPTH = 8;

const envMaxFor = (kind: PoolKind): number | null => {
  const raw =
    kind === 'api'
      ? process.env['API_DB_POOL_MAX']
      : kind === 'worker'
        ? process.env['WORKER_DB_POOL_MAX']
        : process.env['ADMIN_DB_POOL_MAX'];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  // An empty or whitespace-only value is what a chart renders for an unset
  // optional key, so it has to mean "unset" rather than fail the boot.
  if (trimmed === '') return null;
  // Whole-string digits only. `Number.parseInt` reads `1e3` as 1 and `10abc` as
  // 10, so an operator asking for a thousand connections would silently get
  // one, and a typo would silently shrink the pool instead of failing the boot.
  // Safe-integer, not just integer: `Number('9007199254740993')` is an integer
  // that is not the value the operator typed, and a pool that large is no limit
  // at all. Both are better as a failed boot than a silent substitution.
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid pool size for ${kind} pool (env value "${raw}"): expected a positive integer within the safe range`,
    );
  }
  return parsed;
};

/** The size a pool of this kind is created with: the environment, else our default. */
export const resolvePoolMax = (kind: PoolKind): number => envMaxFor(kind) ?? DEFAULT_MAX[kind];

export const createPool = ({ kind, connectionString }: CreatePoolOptions): Pool => {
  const max = resolvePoolMax(kind);
  const config: PoolConfig = {
    connectionString,
    max,
    application_name: `binance-${kind}`,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: POOL_CHECKOUT_TIMEOUT_MS,
  };
  return new Pool(config);
};

/**
 * Which of pg-pool's two deadlines fired.
 *
 * They are not the same fault and the remedies point in opposite directions. `queue-wait` is capacity: every connection was held and none came free, and more connections would help. `cold-connect` means the pool was NOT full — it went to dial a new connection and the database never finished the handshake — so adding connections aims more concurrent attempts at a server already failing to answer, and makes it worse.
 */
export type PoolCheckoutTimeout = 'queue-wait' | 'cold-connect';

/**
 * Which deadline `err` represents, or `null` if it is not a checkout timeout at all.
 *
 * Matched on message text because pg-pool raises both with a bare `new Error(message)` — no SQLSTATE, no error subclass, nothing else to key on. The comparison is EXACT rather than a substring test in both directions: exact means a reworded pg-pool release fails CLOSED (a saturated pool degrades from a 503 back to a 500, which is wrong but not a lie) and takes the real-library test in `__tests__/pool-checkout-timeout.test.ts` red with it, whereas substring matching would quietly relabel any unrelated error whose message happens to quote the phrase — a failed query echoing its own parameters, a wrapper appending context — as backpressure, and answer "retry later" for a fault that will never clear.
 *
 * Walks the `cause` chain for the same reason `isStatementTimeout` does: drizzle wraps a driver error in a `DrizzleQueryError` and puts the original on `.cause`, so in practice the message is never on the outermost object.
 *
 * @param err - Anything caught around a query or an explicit `pool.connect()`; no shape is assumed.
 * @returns The deadline that fired, or `null` when neither literal appears in the chain, so an ordinary connection failure is never reported as backpressure.
 */
export const poolCheckoutTimeoutKind = (err: unknown): PoolCheckoutTimeout | null => {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const { message } = current as { message?: unknown };
    if (message === QUEUE_WAIT_MESSAGE) return 'queue-wait';
    if (message === COLD_CONNECT_MESSAGE) return 'cold-connect';
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};
