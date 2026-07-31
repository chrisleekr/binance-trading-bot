import { callAsync } from './call-async.js';

/**
 * Run a reporting callback so a throw from it cannot escape.
 *
 * Every caller hands `raceDeadline` a `logger.warn`, and pino's default SonicBoom
 * destination throws synchronously from `write()` once destroyed, so this is a real
 * shape during shutdown rather than a defensive flourish. Unguarded it breaks the
 * helper's contract in two different ways: a throw from `onError` rejects the inner
 * chain and rejects the helper, which at the fire-and-forget call site is an
 * unhandled rejection that terminates the worker and takes every in-flight tick with
 * it (nothing in the tree installs an `unhandledRejection` handler); a throw from
 * `onTimeout` pre-empts the `resolve()` behind it, leaving the promise UNSETTLED so an
 * awaiting tick holds its per-(profile, symbol) chain lock forever.
 *
 * Swallowed rather than re-reported, which is the one justified bare swallow here:
 * the channel we would report on is the channel that just failed.
 */
const swallow = (report: () => void): void => {
  try {
    report();
  } catch {
    // Nowhere left to report to.
  }
};

/**
 * Bound a best-effort async call by a deadline.
 *
 * Every backend the tick path writes to can stall without erroring: `ioredis`
 * imposes no command timeout of its own and `maxRetriesPerRequest: null` keeps
 * the command queued, and a Postgres round-trip has no client-side ceiling
 * either. An unbounded await on the tick path is therefore an unbounded tick —
 * and the tick runs inside the per-(profile, symbol) chain lock, so it does not
 * just stretch itself, it delays the NEXT tick for that symbol behind it.
 *
 * Use this for a best-effort write whose REPLY you do not read: one you want
 * attempted, not confirmed. A bounded call whose reply is load-bearing needs the
 * opposite shape and rejects instead, so the caller's error path gets a verdict it can
 * act on. A bounded read that treats a fault and a stall identically has no use for
 * the distinction either shape draws, and races inline.
 *
 * The write arrives as a THUNK, never as an already-created promise, because a
 * promise argument is evaluated by the CALLER. A client that throws before it can
 * return one — a closed connection, an argument the command builder refuses — would
 * then throw outside this helper and unwind a tick that has already placed or
 * cancelled orders. Invoking the thunk here puts the payload build and the call
 * itself inside the guard, which is what makes the contract below true by
 * construction instead of true only while every caller remembers a `.catch`.
 *
 * The thunk must RETURN the call, not merely start it. `async () => { dep(); }` type-
 * checks and is the one shape that defeats the helper: it resolves immediately, so the
 * deadline never applies and the dep's eventual rejection is observed by nobody.
 *
 * Resolves, never rejects. A synchronous throw, a rejection and a stall all route
 * to a callback and are swallowed here, so nothing leaks into the chain-locked
 * critical section:
 *
 *   - `onTimeout` — the deadline was reached. The write is ABANDONED, not
 *     cancelled, so it may still complete afterwards. Treat this as "unknown",
 *     never as "it did not happen".
 *   - `onError` — the thunk threw, or the promise it returned rejected. REQUIRED,
 *     because the only alternative is a silent swallow, and a lost error on a money
 *     path is how a failure becomes invisible (CLAUDE.md: no silent failures). Pass
 *     a no-op only when you can say why the error carries no information.
 *
 * A callback that itself throws cannot break either half of that guarantee — see
 * `swallow`.
 */
export const raceDeadline = (
  write: () => Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
  onError: (err: unknown) => void,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      swallow(onTimeout);
      resolve();
    }, timeoutMs);
    timer?.unref?.();
  });
  // Armed before the thunk runs, so a thunk that throws immediately still has a
  // timer to clear. That rejection settles on the microtask queue, many turns
  // before the macrotask deadline could fire, so no timer is left dangling.
  const bounded = callAsync(write)
    .then(() => undefined)
    .catch((err: unknown) => {
      swallow(() => onError(err));
    })
    .finally(() => timer && clearTimeout(timer));
  return Promise.race([bounded, deadline]);
};
