/**
 * Retry protection for the order-placing tools.
 *
 * Placing an order through this API is NOT idempotent across an HTTP retry. Each POST mints a fresh override-action UUID, that UUID is folded into the Binance `clientOrderId`, and two POSTs therefore produce two different client order ids that Binance accepts as two different orders. The worker-side deduplication that exists keys on `clientOrderId`, so it never fires for them. An agent that times out and retries, which is ordinary and correct agent behaviour, would double-spend.
 *
 * The remedy is a dedup RECORD, not a lock, and the distinction is load-bearing: there is no owner, nothing is released on another caller's behalf, and nothing is refunded. One `SET NX PX` claims the key; the loser does not wait, does not retry and does not queue, it reads what the winner recorded and returns that. The key expires on its own, so a crashed winner costs the operator one dedup window and never a wedged tool.
 *
 * The claim is written BEFORE the call is dispatched, so the record outlives a call that fails. What should happen next depends on something the key itself cannot express: whether the failure proved the order never happened. Those two cases have opposite correct remedies. A refusal that armed nothing must free the key, because the caller most likely to present it again is the one whose argument was just rejected, and holding it would refuse the corrected retry for the rest of the window over a call that never reached the exchange. A failure that may have armed something must hold the key and say so, because the safe reading of "I do not know whether that order exists" is that it might. Collapsing both into one answer makes the advice wrong half the time, so the states below are kept apart and the caller settles the key explicitly on every path.
 *
 * A key names one request, not a slot. The record carries a fingerprint of the arguments it was claimed for, so a key presented again with different arguments is refused instead of being handed the first request's answer. Replaying there would report an order the caller never asked for as the one it did ask for, and silently drop the order it did ask for.
 */

import { createHash } from 'node:crypto';

/** The subset of an ioredis client this module needs, declared structurally so a test can supply a fake without a running server. */
export interface IdempotencyRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

/**
 * How long a key remembers its outcome. Long enough to cover an agent's own retry of a timed-out call and an operator re-asking the same question, short enough that a key the operator genuinely wants to reissue tomorrow is gone.
 */
export const IDEMPOTENCY_WINDOW_MS: number = 15 * 60 * 1000;

/** Sentinel for "claimed, still running". Prefixed with a control character so it can never collide with a real serialised response body, which is always JSON. */
const IN_FLIGHT = '\u0000in-flight';

/** Sentinel for "an earlier call failed in a way that may still have taken effect". Distinct from {@link IN_FLIGHT} because the honest answer to a retry differs: nothing is running, so waiting achieves nothing, and the caller has to go and read the order state instead. */
const FAILED_AMBIGUOUS = '\u0000failed-ambiguous';

/**
 * What a caller presenting this key should do now.
 *
 * `claimed` is the only state that dispatches. The rest are refusals held apart because their remedies differ: `replay` already holds the answer, `in-flight` should wait for the call that is genuinely still running, `ambiguous` must read the order state before deciding anything, `unknown` means the record aged out mid-flight so nothing can be asserted about what the earlier call did, and `mismatch` means the key already belongs to a different request, so the caller needs a new key rather than any answer about the old one.
 */
export type IdempotencyClaim =
  | { readonly status: 'claimed' }
  | { readonly status: 'replay'; readonly recorded: string }
  | { readonly status: 'in-flight' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'unknown' }
  | { readonly status: 'mismatch' };

/**
 * Serialises a value with object keys sorted at every depth.
 *
 * Two agents, or one agent across a retry, can send the same arguments with their keys in a different order. Plain `JSON.stringify` follows insertion order, so the same request would fingerprint differently and a genuine retry would be refused as a mismatch. Undefined object members are dropped and undefined array slots become null, matching what `JSON.stringify` does, so the canonical form describes the same JSON the route would receive.
 *
 * @param value - JSON-shaped value to serialise.
 * @returns A string that is equal for two values exactly when they are equal as JSON, independent of key order.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * Fingerprints the request a key is being claimed for.
 *
 * The key itself is left out because it is the identifier of the request rather than part of it; including it would make every fingerprint unique to its key and the comparison meaningless. Hashed rather than stored verbatim so the companion record stays small and does not keep a second copy of order arguments in Redis.
 *
 * @param args - Validated tool arguments, including the caller's `idempotencyKey`, which is excluded here.
 * @returns Hex SHA-256 of the canonical arguments.
 */
export const idempotencyFingerprint = (args: Readonly<Record<string, unknown>>): string => {
  const { idempotencyKey: _key, ...request } = args;
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
};

/** Companion key holding the fingerprint of the request a dedup key was claimed for. Kept beside the record rather than inside it so the record's replay body stays exactly what the route answered. */
const fingerprintKeyFor = (key: string): string => `${key}:fp`;

/**
 * The Redis key one tool invocation deduplicates on.
 *
 * The operator id is in the key because a dedup window is per-identity: two different tokens presenting the same key are two different intents, and letting one suppress the other would be a cross-principal denial of service. The tool name is in it because the same key used for a buy and a sell means two different orders.
 *
 * @param operatorId - Owner the token resolved to.
 * @param tool - Tool name being invoked.
 * @param key - Caller-supplied idempotency key.
 * @returns The namespaced Redis key.
 */
export const idempotencyKeyFor = (operatorId: string, tool: string, key: string): string =>
  `mcp:idem:${operatorId}:${tool}:${key}`;

/**
 * Claims the dedup key for this invocation, or reports why this caller must not dispatch.
 *
 * @param redis - Redis client the record lives in.
 * @param key - Namespaced key from {@link idempotencyKeyFor}.
 * @param fingerprint - {@link idempotencyFingerprint} of this call's arguments, compared against the one the key was first claimed with.
 * @returns The state this caller is in, per {@link IdempotencyClaim}.
 */
export const claimIdempotencyKey = async (
  redis: IdempotencyRedis,
  key: string,
  fingerprint: string,
): Promise<IdempotencyClaim> => {
  const won = await redis.set(key, IN_FLIGHT, 'PX', IDEMPOTENCY_WINDOW_MS, 'NX');
  if (won === 'OK') {
    try {
      await redis.set(fingerprintKeyFor(key), fingerprint, 'PX', IDEMPOTENCY_WINDOW_MS);
    } catch (err) {
      // Nothing has been dispatched yet, so the claim is given back before the failure propagates. Leaving it would answer every retry of this exact call with "still running" for the whole window, about a call that never ran.
      await redis.del(key).catch(() => undefined);
      throw err;
    }
    return { status: 'claimed' };
  }
  // Checked ahead of every other state because none of their answers is about this request. An absent fingerprint, from a winner that has not written it yet or a record that predates it, falls through to the state-based answers, which still refuse or replay without dispatching.
  const recordedFingerprint = await redis.get(fingerprintKeyFor(key));
  if (recordedFingerprint !== null && recordedFingerprint !== fingerprint) {
    return { status: 'mismatch' };
  }
  const existing = await redis.get(key);
  // A key that expired between the failed SET and this GET is gone, and the honest answer is that the earlier outcome is no longer known. Treating that as "go ahead and place it" would defeat the mechanism at exactly the moment it matters, so the caller is refused and told the record aged out rather than being given a comforting fiction about what the earlier call did.
  if (existing === null) return { status: 'unknown' };
  if (existing === IN_FLIGHT) return { status: 'in-flight' };
  if (existing === FAILED_AMBIGUOUS) return { status: 'ambiguous' };
  return { status: 'replay', recorded: existing };
};

/**
 * Records the outcome so a retry inside the window gets the same answer instead of a second order.
 *
 * Deliberately not conditional: the caller writing here is the one that claimed the key, and a refused write would leave the record stuck on the in-flight sentinel, which turns every retry into an unanswerable call.
 *
 * @param redis - Redis client the record lives in.
 * @param key - Namespaced key from {@link idempotencyKeyFor}.
 * @param body - Serialised response body to replay to a retry.
 * @returns Nothing; a failure to record is not worth failing an order that already placed.
 */
export const recordIdempotentOutcome = async (
  redis: IdempotencyRedis,
  key: string,
  body: string,
): Promise<void> => {
  await redis.set(key, body, 'PX', IDEMPOTENCY_WINDOW_MS);
  // The record's window restarts here, so the fingerprint's must too, or it would expire first and a different request under this key would be handed this body as its answer.
  await redis.pexpire(fingerprintKeyFor(key), IDEMPOTENCY_WINDOW_MS);
};

/**
 * Frees a key whose call provably armed nothing, so the same key can be presented again immediately.
 *
 * This is not a lock release: there is no owner and no waiter to hand anything to. It withdraws a dedup record that turned out to describe no effect at all. Keeping it would be worse than useless, because the caller most likely to retry is the one whose argument was just refused, and it would go on being refused for the rest of the window over a call that never reached the exchange.
 *
 * Only ever called for a refusal known to precede every write. A failure that might have taken effect goes to {@link markIdempotencyAmbiguous} instead.
 *
 * @param redis - Redis client the record lives in.
 * @param key - Namespaced key from {@link idempotencyKeyFor}.
 * @returns Nothing; failing to free the key costs one dedup window and never an order.
 */
export const releaseIdempotencyKey = async (
  redis: IdempotencyRedis,
  key: string,
): Promise<void> => {
  // The fingerprint goes with the record, because a released key is free for any request, including a corrected one whose arguments differ from the refused call.
  await redis.del(key, fingerprintKeyFor(key));
};

/**
 * Holds a key whose call failed after it may already have armed an order, and marks it so a retry is told the truth.
 *
 * The key is kept rather than freed because a retry could otherwise become a second real order. What changes is only the answer a retry receives: not "still running", which invites waiting for something that already stopped, but an instruction to go and read the order state before deciding.
 *
 * @param redis - Redis client the record lives in.
 * @param key - Namespaced key from {@link idempotencyKeyFor}.
 * @returns Nothing; if the mark fails the key stays on its in-flight sentinel, which is the more conservative of the two refusals.
 */
export const markIdempotencyAmbiguous = async (
  redis: IdempotencyRedis,
  key: string,
): Promise<void> => {
  await redis.set(key, FAILED_AMBIGUOUS, 'PX', IDEMPOTENCY_WINDOW_MS);
  // Kept alive for as long as the ambiguous mark, so a different request under this key is told to use a new key rather than told to reconcile an order it never asked for.
  await redis.pexpire(fingerprintKeyFor(key), IDEMPOTENCY_WINDOW_MS);
};
