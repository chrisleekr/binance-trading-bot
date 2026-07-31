// account-snapshot-safety cron.
//
// REST fallback that keeps `account-info` fresh. Skip the refresh only when
// BOTH hold: a WS event arrived within the staleness window (default 30s) AND
// the cache key still exists. The WS marker alone is not enough — every
// user-stream frame stamps it, but only `account-position` frames write the
// cache, so an `executionReport`-only burst (e.g. protective-stop churn) keeps
// the marker fresh while the 35s cache lapses. Gating on key presence makes
// the cron repopulate an expired cache even while the stream is live, and seed
// it at the cold-start boot window before any WS frame arrives.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceRestClient } from '@app/binance';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { createAccountSnapshotStore } from './account-snapshot.js';

/**
 * Binance `getAccount` is weight-10. 4 concurrent calls per 5s cron tick
 * leave the per-IP weight budget largely free for the tick path — the
 * effective ceiling here is REST socket count, not Binance weight.
 */
const ACCOUNT_SNAPSHOT_CONCURRENCY = 4;

export interface AccountSnapshotSafetyDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
  readonly persistAccount: (
    accountId: AccountId,
    profileId: ProfileId,
    balances: readonly { asset: string; free: string; locked: string }[],
  ) => Promise<void>;
  readonly lastWsEventMs: (accountId: AccountId, profileId: ProfileId) => Promise<number | null>;
  readonly accountInfoExists: (accountId: AccountId, profileId: ProfileId) => Promise<boolean>;
  readonly clock?: { nowMs(): number };
  readonly staleThresholdMs?: number;
  /**
   * Force a full `getAccount` reconcile this often (default 30s) even while the
   * WS marker is fresh and the cache is present. `mergeAccount` patches only the
   * assets a frame changed and keeps the key alive (resetting its TTL), so a
   * delta that is missed or dropped — e.g. an `outboundAccountPosition` unlock
   * that never arrives — leaves a stale per-asset balance the WS path alone
   * never corrects. Without a forced reconcile the `wsFresh && present` skip
   * fires forever and the drift persists indefinitely, starving the protective
   * stop (it reads a phantom-zero free balance and cancels itself). Bounding the
   * reconcile interval caps how long any drift can survive.
   */
  readonly fullReconcileIntervalMs?: number;
}

type RefreshOutcome = 'refreshed' | 'skipped';

export const accountSnapshotSafetyHandler = (deps: AccountSnapshotSafetyDeps) => {
  // Wall-clock of the last full `getAccount` reconcile per (user, profile).
  // In-memory: the worker is single-replica, and the boot seed runs a full
  // refresh, so a fresh process starts reconciled. Bounds how long a drifted
  // merge value survives while the WS stream is healthy and the cache present.
  const lastFullReconcileMs = new Map<string, number>();
  return async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const threshold = deps.staleThresholdMs ?? 30_000;
    const reconcileInterval = deps.fullReconcileIntervalMs ?? 30_000;
    const profiles = deps.listActive();
    const { ok, errors } = await fanOutBounded<ActiveProfile, RefreshOutcome>(
      profiles,
      async (profile) => {
        const id = `${profile.accountId}:${profile.profileId}`;
        const now = clock.nowMs();
        // Skip the REST refresh only when the stream is live AND the cache is
        // still present. A fresh WS marker proves the socket is delivering,
        // but only `account-position` frames write the cache — so an
        // `executionReport`-only burst keeps the marker fresh while the 35s
        // key expires. The presence check also seeds the cold-start window:
        // at boot the key is absent and no WS frame has arrived, so refresh.
        // `accountInfoExists` is only read when the marker is fresh, so the
        // common dropped-WS path keeps its single round-trip.
        const last = await deps.lastWsEventMs(profile.accountId, profile.profileId);
        const wsFresh = last !== null && now - last < threshold;
        // First sight of a profile starts reconciled (boot seed did a full
        // refresh), so the normal skip applies; only force a reconcile once the
        // interval has elapsed since the last full `getAccount`. This is what
        // corrects a stale merged balance the WS path alone would never fix.
        const lastFull = lastFullReconcileMs.get(id);
        if (lastFull === undefined) lastFullReconcileMs.set(id, now);
        const reconcileDue = lastFull !== undefined && now - lastFull >= reconcileInterval;
        if (
          wsFresh &&
          !reconcileDue &&
          (await deps.accountInfoExists(profile.accountId, profile.profileId))
        )
          return 'skipped';
        const rest = await deps.resolveBinance(profile.operatorId, profile.accountId);
        if (!rest) return 'skipped';
        const account = await rest.getAccount();
        await deps.persistAccount(profile.accountId, profile.profileId, account.balances);
        lastFullReconcileMs.set(id, now);
        return 'refreshed';
      },
      { concurrency: ACCOUNT_SNAPSHOT_CONCURRENCY, onError: 'collect' },
    );
    const refreshed = ok.filter((o) => o === 'refreshed').length;
    const skipped = ok.filter((o) => o === 'skipped').length;
    for (const { item, error } of errors) {
      deps.logger.warn(
        { profileId: item.profileId, err: error },
        'account-snapshot-safety: REST refresh failed (will retry next tick)',
      );
    }
    // debug, not info: this cron fires every 5s — an info line per tick
    // would flood logs. A genuine failure is already logged at warn.
    deps.logger.debug(
      { refreshed, skipped, failed: errors.length },
      'cron account-snapshot-safety: complete',
    );
  };
};

export const buildAccountSnapshotSafetyCron = (ctx: BootContext): CronDef => {
  const store = createAccountSnapshotStore(ctx.redis);
  return defineCron({
    name: 'account-snapshot-safety',
    queue: QUEUE_NAMES.accountSnapshotSafety,
    pattern: '*/5 * * * * *',
    handler: accountSnapshotSafetyHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      resolveBinance: ctx.resolveBinanceClient,
      persistAccount: store.persistAccount,
      lastWsEventMs: store.lastWsEventMs,
      accountInfoExists: store.accountInfoExists,
    }),
  });
};
