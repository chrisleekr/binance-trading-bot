// A server-enforced execution budget for one query, and the classifier for the error it raises.
//
// Racing a timer against the promise does not help here: `pg` hands a pooled connection back only when its query settles, so an abandoned await keeps the connection busy for as long as the query runs. A caller that abandons one query per pass therefore converts a single stalled statement into pool exhaustion. `statement_timeout` instead makes the SERVER cancel the backend, which both frees the connection and surfaces a real error to the caller.
//
// The setting is applied with `is_local = true` so it belongs to the enclosing transaction. That reverts it at COMMIT or ROLLBACK only when this call OWNS the transaction, which is why a non-pool handle is refused below: Postgres does not undo a transaction-local setting when a SAVEPOINT is released, so running this inside somebody else's transaction would leave the cap binding the rest of their work. A session-level `SET` would be worse still, outliving the transaction entirely and capping every later borrower of that pooled connection with a budget none of them asked for.

import { sql } from 'drizzle-orm';
import type { Database } from './repo/_db.js';

/** SQLSTATE `query_canceled`. Postgres raises it whenever a running statement is cancelled, so `statement_timeout` is the expected cause here but not the only one: an operator `pg_cancel_backend()` and a server-level timeout produce the same code. Matching on the code alone is still the right call, because the alternative is sniffing the message text, which changes under a non-English `lc_messages`. */
const QUERY_CANCELED = '57014';

/** Bound on how far the cause chain is walked, so a self-referencing `cause` cannot spin forever. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Run `fn` in a transaction where EACH statement `fn` issues is capped at `ms` of execution time.
 *
 * The cap is per statement, not per callback: a body issuing three statements can still run for three times `ms`. The `begin` that opens the transaction is NOT covered, since drizzle issues it before the callback runs and therefore before `set_config` arms the budget; `commit` and `rollback` are covered but have nothing to stall on. It also covers execution only: waiting for a free pool connection is bounded separately, by the `connectionTimeoutMillis` every pool is created with. This bounds a stalled statement, not a saturated pool.
 *
 * Both arguments are validated rather than trusted, because either one being wrong disables the bound silently and leaves the caller believing it is protected.
 *
 * @param db - Pool-backed handle, the kind `createDb` returns. A transaction handle is REFUSED: drizzle would nest it as a savepoint, and the cap would then outlive this call and bind the rest of the caller's transaction. The repo casts a `tx` back to `Database` in places, so this is reachable without a type error.
 * @param ms - Per-statement execution budget in milliseconds. Must be a positive safe integer: Postgres reads `statement_timeout = 0` as NO LIMIT, so a caller deriving this from an unset config value would otherwise get a silently disabled guard.
 * @param fn - Body to run, handed the transaction-scoped handle. Statements issued on any other handle are NOT covered by the budget.
 * @returns Whatever `fn` resolves to, once the transaction commits.
 */
export const withStatementTimeout = async <T>(
  db: Database,
  ms: number,
  fn: (tx: Database) => Promise<T>,
): Promise<T> => {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `withStatementTimeout: budget must be a positive safe integer of milliseconds, got ${String(ms)}. Postgres treats 0 as no limit, so a bad value would disable the bound instead of applying it.`,
    );
  }
  // `$client` is assigned by the node-postgres driver on the pool-backed handle only, so its absence is what a transaction handle looks like here.
  if (!('$client' in db)) {
    throw new Error(
      'withStatementTimeout: requires a pool-backed database handle. Called on a transaction handle, drizzle opens a SAVEPOINT, and Postgres does not revert a transaction-local setting when a savepoint is released, so the budget would bind the rest of the surrounding transaction.',
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(ms)}, true)`);
    return fn(tx);
  });
};

/**
 * Whether `err` is Postgres reporting a cancelled statement, which under this helper means the budget was hit.
 *
 * Walks the `cause` chain because drizzle wraps a driver error in a `DrizzleQueryError` and puts the original on `.cause`, so in practice the code is never on the outermost object. A check that read only the top level would classify every cancelled query as an ordinary fault.
 *
 * @param err - Anything caught from a query; no shape is assumed.
 * @returns True only when SQLSTATE 57014 appears at some depth of the chain, so an unrelated database fault is never relabelled a timeout.
 */
export const isStatementTimeout = (err: unknown): boolean => {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === QUERY_CANCELED) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};
