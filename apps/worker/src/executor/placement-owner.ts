// Placement-ownership marker for the cross-profile isolation gate.
//
// One Binance account is shared by N profiles but issues ONE user-data stream, so every active profile receives every `executionReport`. The gate that decides ownership reads the account's `orders` row — which is written AFTER the REST placement returns, while Binance pushes the report BEFORE it. In that window no row exists for anyone, the gate has no positive owner, and it hands the order to whichever profile asks: a sibling adopts a foreign fill and ticks a symbol it is not bound to.
//
// This closes the window with the one fact available at the moment of placement: the profile that is about to send the order stamps its id under the order's clientOrderId, BEFORE the request goes out. The gate consults that stamp when the row lookup misses.
//
// NOT A LOCK. The key has no owner semantics, no acquire/release pair and no waiter: `register` overwrites unconditionally (no `NX`), nothing ever deletes it, and it self-expires. It is a short-lived attribution record — the same class of shared-Redis primitive as the notifier-gap throttle and the request-weight bucket, which the no-locks rule permits.
//
// FAIL-OPEN READ, NEVER-THROW WRITE, matching the placement-dedup mirror it sits beside. A read fault answers "no marker", which leaves the gate on exactly the behaviour it had before this module existed. A write fault cannot fail a placement: the marker is an aid to attribution, and an order that never places is a strictly worse outcome than one whose owner has to be inferred.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AccountId, ProfileId } from '@app/contracts';
import { unwrapId } from '@app/contracts';

import { raceDeadline } from 'lib/race-deadline.js';
import { buildPlacementOwnerKey } from './redis-namespace.js';

/**
 * Marker lifetime. It only has to outlive the gap between the placement request and the `orders` row commit — milliseconds in the healthy case, but a retried tick can re-derive the same clientOrderId minutes later, and a marker that has expired reads as "no marker" and falls back to the pre-fix behaviour. Five minutes is long enough to cover a stalled placement and short enough that a stale attribution cannot outlive the order it describes.
 */
export const DEFAULT_PLACEMENT_OWNER_TTL_MS = 300_000;

// The executor's ioredis runs with `maxRetriesPerRequest: null` and no command timeout, so a reachable-but-stalled Redis would hang both calls. The write sits on the placement path and the read sits on the execution-report path; neither may stretch on a stalled server. Mirrors the placement-dedup mirror's deadline.
const PLACEMENT_OWNER_REDIS_TIMEOUT_MS = 500;

// A SUPERSET of the only clientOrderId character class Binance actually publishes, which is in the FIX API spec: `^[a-zA-Z0-9-_]{1,36}$` (https://github.com/binance/binance-spot-api-docs/blob/master/fix-api.md, "Client order ID fields must conform to the regex"). The REST and WebSocket docs state the 36-char uniqueness rule for `newClientOrderId` but publish no character class at all, and Binance's own generated ids and its connector libraries use `.`, `:` and `/` — so this admits those too.
//
// Superset ON PURPOSE, because the two directions are not symmetric. Refusing an id that is in fact legal loses the marker and silently returns the gate to its pre-fix behaviour, which is the defect this module exists to close. Accepting a generous class costs nothing: a real id is specific to one order and keys normally. What must be excluded is only the values that are CONSTANT across distinct orders or that Binance could not have issued, and those fall outside any of these spellings. `\w` is `[A-Za-z0-9_]`, so the underscore — legal, and used by ids from Binance's own web UI (`web_…`) — is included, and the sibling test pins that in the accept direction.
const CLIENT_ORDER_ID_RE = /^[\w.:/-]{1,36}$/;

/**
 * Whether an id may be used as a marker key at all, asked of both ends of the marker.
 *
 * The hazard is a value that is CONSTANT across distinct orders, or one Binance would never have issued: every order in such a class shares one key, and the marker then names whichever profile last placed with an id of that shape as the owner of all of them. Refusing the class is strictly narrowing — a non-conforming id yields no marker and the gate falls back to the verdict it gave before markers existed.
 *
 * The protection has two halves in two places, deliberately. `parseUserStreamFrame` refuses to COIN an id: it reads `c` as a string or yields `''`, so a non-string JSON scalar can no longer stringify into a legal-looking id (`'0'`, `'false'`) that this predicate would have to accept, because it is indistinguishable from an operator who genuinely named an order that. This predicate is the second half: it rejects what a frame can still legitimately carry into the keyspace — the empty id from an omitted `c`, an over-length one, one built from characters no Binance id uses — and it holds whatever any future producer does.
 *
 * @param clientOrderId - The id to key by: off the wire on the read side, from the decision intent on the write side.
 * @returns True when the id is specific enough to one order to be safe as a key.
 */
const isKeyable = (clientOrderId: string): boolean => CLIENT_ORDER_ID_RE.test(clientOrderId);

export interface PlacementOwner {
  /**
   * Stamps `profileId` as the placer of `clientOrderId`. Awaited by the caller so the marker is durable BEFORE the order is transmitted; resolves (never rejects) whatever Redis does.
   *
   * @param accountId - Account whose shared user-data stream will carry the resulting report.
   * @param profileId - Profile about to transmit the order, the value the gate reads back.
   * @param clientOrderId - The order's client id, the only handle both sides hold before the `orders` row exists.
   * @returns Nothing; a failed or stalled write is logged and swallowed.
   */
  register(accountId: AccountId, profileId: ProfileId, clientOrderId: string): Promise<void>;
  /**
   * Reads back the profile id stamped for `clientOrderId`, or null when there is no marker.
   *
   * @param accountId - Account the execution report arrived on.
   * @param clientOrderId - Client id carried by the report; one that is not a legal Binance id is refused without a lookup, per {@link isKeyable}.
   * @returns The raw profile id string a `register` stored, or null when no marker exists, the id is unusable as a key, the read failed, or it stalled. Raw rather than branded because the value comes back off the wire and has not been proven to name a live profile.
   */
  ownerOf(accountId: AccountId, clientOrderId: string): Promise<string | null>;
}

export interface PlacementOwnerDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  /** Marker lifetime; defaults to {@link DEFAULT_PLACEMENT_OWNER_TTL_MS}. */
  readonly ttlMs?: number;
  /** Deadline for either Redis round-trip. Test seam; production takes the default. */
  readonly redisTimeoutMs?: number;
}

/**
 * Builds the placement-ownership marker store. Both ends mint their key through {@link buildPlacementOwnerKey}, so the writer and the reader cannot drift apart.
 *
 * @param deps - Redis connection, logger, and the optional lifetime / deadline overrides.
 * @returns The `register` / `ownerOf` pair, wired to one Redis connection.
 */
export const createPlacementOwner = (deps: PlacementOwnerDeps): PlacementOwner => {
  const ttlMs = deps.ttlMs ?? DEFAULT_PLACEMENT_OWNER_TTL_MS;
  const timeoutMs = deps.redisTimeoutMs ?? PLACEMENT_OWNER_REDIS_TIMEOUT_MS;

  return {
    register: async (accountId, profileId, clientOrderId) => {
      // Same predicate as the read, because a marker the reader would refuse is worse than no marker: the key exists, nothing can ever answer from it, and the gate reads as armed while it is not. Unreachable today — every id builder conforms — but `assertClientOrderId` checks LENGTH only and never the character class, so nothing structurally stops a future one. Loud rather than silent, since a strategy minting unkeyable ids has disarmed the isolation gate for its own orders.
      if (!isKeyable(clientOrderId)) {
        deps.logger.warn(
          { accountId, profileId, clientOrderId },
          'placement-owner: refusing to stamp a marker for an id that cannot be a key; this order is invisible to the cross-profile ownership gate',
        );
        return;
      }
      const key = buildPlacementOwnerKey(accountId, clientOrderId);
      // PX in the same command as the value: a SET that could exist without a TTL would leave a permanent attribution for a clientOrderId the strategy legitimately reuses later.
      await raceDeadline(
        () => deps.redis.set(key, unwrapId(profileId), 'PX', ttlMs),
        timeoutMs,
        () =>
          deps.logger.warn(
            { accountId, profileId, clientOrderId },
            'placement-owner: marker write timed out; a sibling may process this order before its row commits',
          ),
        (err: unknown) =>
          deps.logger.warn(
            { accountId, profileId, clientOrderId, err: err },
            'placement-owner: marker write failed; a sibling may process this order before its row commits',
          ),
      );
    },

    // Hand-rolled rather than via `raceDeadline`: that helper resolves to void by contract, and this call's REPLY is the whole point.
    ownerOf: async (accountId, clientOrderId) => {
      if (!isKeyable(clientOrderId)) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('placement-owner: GET timed out')), timeoutMs);
        });
        return await Promise.race([
          deps.redis.get(buildPlacementOwnerKey(accountId, clientOrderId)),
          deadline,
        ]);
      } catch (err: unknown) {
        // Fail open to "no marker": the gate's other evidence still applies, so a Redis fault costs the window this module closes and nothing else. The `get` is INSIDE the try so a client that throws synchronously — a closed connection — lands here too, rather than rejecting the gate's whole lookup into its fail-CLOSED arm.
        deps.logger.warn(
          { accountId, clientOrderId, err: err },
          'placement-owner: marker read failed; falling back to the orders-row verdict',
        );
        return null;
      } finally {
        // Unconditional: the Promise executor above runs synchronously during construction, so the timer is always set by the time this runs, and `clearTimeout(undefined)` would be a no-op regardless. A guard here is a branch nothing can take.
        clearTimeout(timer);
      }
    },
  };
};
