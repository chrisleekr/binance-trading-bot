/**
 * Invoke an injected dependency so a SYNCHRONOUS throw becomes a rejection.
 *
 * A trailing `.catch` only ever sees the promise a dependency RETURNS, so a throw
 * raised before that return escapes it. On a fire-and-forget `void call().catch(…)`
 * nothing else is watching, and on the tick path the escape lands at the worst
 * possible point: the caller has already disarmed the override's compensation, so
 * the throw fails an otherwise successful tick and strands the row pending with no
 * re-arm. An async body turns that throw into a rejection the existing handler
 * already covers, and still runs the call eagerly (an async function body runs
 * synchronously up to its first await), so the dependency is invoked at exactly the
 * same point as before. Adopting the dependency's promise settles the wrapper a few
 * microtask turns after that promise, which none of the callers here observe.
 *
 * `raceDeadline` is built on this and applies it to its own thunk, so a
 * deadline-bounded write is already covered and must not be wrapped again.
 */
export const callAsync = async <T>(call: () => Promise<T>): Promise<T> => call();
