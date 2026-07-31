// Subscription ownership — distributes per-account user-data streams across the
// worker fleet so exactly one live pod holds each account's stream.
//
// Ownership is a pure function of the fleet ready-member set and HRW hashing: a
// pod owns an account iff `rendezvousOwner(accountKey, readyMembers) === selfId`.
// There is no owner key, no lock, nothing to release — a pod leaving (its member
// key expiring) changes the member set, which every survivor re-evaluates
// independently to the same new owner.
//
// This manager only opens and closes streams; it never processes fills. The
// user-stream pool's open() already reconciles open state on assume (onResync →
// fill backfill under the chain lock), and a brief handoff overlap is safe
// because fills are idempotent on (orderId, tradeId) in `applied_fills`. So the
// two failure modes of moving a stateful subscription — a missed fill during the
// gap, a double-processed fill during overlap — are both already covered.
//
// Fail-open: if the member set can't be read, or this pod is not in it, the
// reconcile is skipped rather than tearing down streams. Losing the user-data
// stream loses fills (and any protective SELL they would trigger), so a Redis
// blip must never close a live stream — the heartbeat restores this pod's member
// key and the next reconcile converges.
//
// Sole user-data stream driver: profileManager registers membership + market
// subs but never opens the account stream, so this manager is the ONLY thing
// that opens/closes it. At single replica the sole ready member owns every
// account, so the first reconcile opens all streams at boot.
//
// Account universe: this elects over profileManager.listActive(). The
// enabled-set reconciler (#579) converges every pod's listActive() to the
// fleet-global enabled set on an interval, so a subscribe/unsubscribe applied
// by a single-consumer pipeline job on one pod re-elects fleet-wide within one
// reconcile interval (the consuming pod also kicks reconcile() immediately).
// The election is therefore complete at any replica count.

import { listReadyMembers } from '@app/db';
import { Gauge, type Registry } from '@app/observability';
import { rendezvousOwner } from '@app/core/hrw';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { MEMBER_REFRESH_MS } from 'boot/member-registry.js';

/** The subset of an active profile ownership needs: which account (the HRW key
 * and credential source), which operator, which stream. All profiles under one
 * account hash to the same owner, so the account's streams land on one pod. */
export interface OwnedProfile {
  readonly profileId: ProfileId;
  readonly operatorId: UserId;
  readonly accountId: AccountId;
}

/** The pool surface ownership drives — open/close a stream, inspect open state. */
export interface OwnershipPool {
  open(operatorId: UserId, accountId: AccountId, profileId: ProfileId): Promise<void>;
  close(operatorId: UserId, accountId: AccountId, profileId: ProfileId): Promise<void>;
  isOpen(profileId: ProfileId): boolean;
}

export interface SubscriptionOwnershipDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  /** This pod's fleet id — must equal the member-registry id (hostname:pid). */
  readonly selfId: string;
  readonly pool: OwnershipPool;
  /** Live active profiles; ownership hashes on their `accountId`. */
  readonly listActive: () => readonly OwnedProfile[];
  readonly metrics: { readonly registry: Registry };
  /** Reconcile cadence. Defaults to the member heartbeat so ownership converges
   *  within ~one refresh of a membership change. */
  readonly reconcileIntervalMs?: number;
}

export interface SubscriptionOwnership {
  /** Recompute owned accounts and open/close streams to match. Best-effort. */
  reconcile(): Promise<void>;
  /** Run one reconcile now, then on the interval. Call after markReady(). */
  start(): Promise<void>;
  /** Stop the interval. Streams are torn down by the pool's own shutdown. */
  stop(): void;
}

/** HRW key for an account. AccountId is a branded string; coerce for hashing. */
const accountKey = (accountId: AccountId): string => `${accountId}`;

export const createSubscriptionOwnership = (
  deps: SubscriptionOwnershipDeps,
): SubscriptionOwnership => {
  const { redis, logger, selfId, pool, listActive, metrics } = deps;
  const intervalMs = deps.reconcileIntervalMs ?? MEMBER_REFRESH_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  // Streams this pod has opened, profileId -> {operatorId, accountId}. Needed to
  // close a stream whose profile left listActive entirely (an unsubscribe): the
  // reconcile loop iterates listActive, so a departed profile is never visited
  // there, and profileManager no longer closes streams (ownership is the sole
  // driver). The ids are retained because close() needs them and the departed
  // profile is gone from listActive.
  const streamedByUs = new Map<ProfileId, { operatorId: UserId; accountId: AccountId }>();

  const ownedGauge = new Gauge({
    name: 'worker_owned_accounts',
    help: 'Accounts whose user-data subscription this pod owns via HRW election.',
    registers: [metrics.registry],
  });

  const reconcile = async (): Promise<void> => {
    // Serialise: a reconcile awaits stream opens (WS handshake + backfill), so a
    // slow one must not overlap the next interval tick and double-drive the pool.
    if (inFlight) return;
    inFlight = true;
    try {
      let members: readonly string[];
      try {
        members = await listReadyMembers(redis);
      } catch (err) {
        logger.warn(
          { err: err },
          'subscription-ownership: member read failed; keeping current streams',
        );
        return;
      }
      // Fail-open: without this pod in the ready set, ownership is indeterminate
      // (Redis blip, or our own key expired). Do not close streams — the
      // heartbeat re-registers us and the next reconcile converges.
      if (!members.includes(selfId)) {
        logger.warn(
          { selfId, memberCount: members.length },
          'subscription-ownership: self not in ready member set; skipping reconcile',
        );
        return;
      }
      const active = listActive();
      const activeProfiles = new Set<ProfileId>();
      const ownedAccounts = new Set<string>();
      for (const { operatorId, accountId, profileId } of active) {
        activeProfiles.add(profileId);
        const key = accountKey(accountId);
        const owns = rendezvousOwner(key, members) === selfId;
        if (owns) {
          ownedAccounts.add(key);
          streamedByUs.set(profileId, { operatorId, accountId });
          // Only open when not already connected — open() re-runs onResync (a
          // getMyTrades backfill), so blind-calling it every tick is wasteful.
          if (!pool.isOpen(profileId)) {
            await pool
              .open(operatorId, accountId, profileId)
              .catch((err: unknown) =>
                logger.error({ profileId, err: err }, 'subscription-ownership: open failed'),
              );
          }
        } else {
          // Close unconditionally, not just when isOpen: close() revokes the
          // pool's intent, so a stream the watchdog is mid-reconnect on (intent
          // still set, no live conn) is not reopened after we cede ownership.
          // close() is a cheap no-op when there is nothing to close.
          streamedByUs.delete(profileId);
          await pool
            .close(operatorId, accountId, profileId)
            .catch((err: unknown) =>
              logger.error({ profileId, err: err }, 'subscription-ownership: close failed'),
            );
        }
      }
      // Close streams for profiles that left listActive entirely (unsubscribed):
      // the loop above only visits still-active profiles, so a departed one
      // would leak its open stream. profileManager no longer closes streams, so
      // this is the sole teardown path on unsubscribe.
      for (const [profileId, { operatorId, accountId }] of streamedByUs) {
        if (activeProfiles.has(profileId)) continue;
        streamedByUs.delete(profileId);
        await pool
          .close(operatorId, accountId, profileId)
          .catch((err: unknown) =>
            logger.error(
              { profileId, err: err },
              'subscription-ownership: close of departed profile failed',
            ),
          );
      }
      ownedGauge.set(ownedAccounts.size);
    } finally {
      inFlight = false;
    }
  };

  return {
    reconcile,
    async start() {
      await reconcile();
      timer = setInterval(() => void reconcile(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
};
