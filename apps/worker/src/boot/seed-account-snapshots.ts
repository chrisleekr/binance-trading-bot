// Boot-time seed for the `account-info` cache.
//
// The cache is otherwise written lazily: by `mergeAccount` on an
// `outboundAccountPosition` WS frame (a real balance change) or by the
// `account-snapshot-safety` cron's REST refresh. Neither fires at the instant
// the worker boots, so until the first writer lands the dashboard projection
// (which has no REST fallback, unlike the tick path) reads an empty key and
// renders "No balances — the account snapshot is empty." The operator restarts
// the worker to deploy, so this blank window recurs on every restart.
//
// This seed does one unconditional `getAccount -> persistAccount` per active
// profile at boot, closing the window to ~0 instead of waiting for the first
// cron tick. Per-profile failures are isolated and logged; the cron still
// repopulates on its next tick, so a flaky seed never aborts boot.
//
// The write is a FULL-snapshot overwrite, and the user stream is already open
// when this runs (profileManager.start() precedes the boot reconcilers), so it
// shares the same read-modify-write non-atomicity that `mergeAccount` documents
// against `persistAccount`: a balance-change frame can land between this seed's
// `getAccount` read and its write, and the overwrite then reverts that one
// asset to its pre-frame value. That window is bounded and self-heals (the next
// `account-position` frame for the asset, or the safety cron's next full
// refresh once the 35s key lapses). The overwrite is deliberately
// unconditional rather than gated on cache absence: a single early
// `account-position` frame (e.g. the boot reaper unlocking balance on a cancel)
// writes only its changed asset, so a presence-gated seed would skip and leave
// that PARTIAL snapshot visible until the next frame — strictly worse for the
// dashboard than the full overwrite's brief one-asset staleness.

import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceRestClient } from '@app/binance';
import { fanOutBounded } from '@app/core/fan-out';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';

// Matches the safety cron's concurrency: `getAccount` is weight-10, and a
// handful of concurrent calls at boot leave the per-IP budget free for the
// priming path.
const SEED_CONCURRENCY = 4;

export interface SeedAccountSnapshotsDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<{ getAccount: BinanceRestClient['getAccount'] } | null>;
  readonly persistAccount: (
    accountId: AccountId,
    profileId: ProfileId,
    balances: readonly { asset: string; free: string; locked: string }[],
  ) => Promise<void>;
  /**
   * Cache the permission tags carried on the same `getAccount` response. Seeded
   * here so the very first tick after boot can already refuse a symbol the
   * account is not permitted to trade, rather than waiting for the safety
   * cron's first full reconcile.
   */
  readonly persistAccountPermissions: (
    accountId: AccountId,
    permissions: readonly string[] | undefined,
  ) => Promise<void>;
}

export interface SeedTally {
  readonly seeded: number;
  /** Profiles with no resolvable Binance credentials (key not yet saved). */
  readonly skipped: number;
  readonly failed: number;
}

type SeedOutcome = 'seeded' | 'skipped';

/**
 * Seeds the `account-info` cache for every active profile once at boot.
 * Returns a per-call tally so the boot wiring can log a single summary line.
 */
export const runAccountSnapshotSeed = async (
  deps: SeedAccountSnapshotsDeps,
): Promise<SeedTally> => {
  const { ok, errors } = await fanOutBounded<ActiveProfile, SeedOutcome>(
    deps.listActive(),
    async (profile) => {
      const rest = await deps.resolveBinance(profile.operatorId, profile.accountId);
      if (!rest) return 'skipped';
      const account = await rest.getAccount();
      await deps.persistAccount(profile.accountId, profile.profileId, account.balances);
      await deps.persistAccountPermissions(profile.accountId, account.permissions);
      return 'seeded';
    },
    { concurrency: SEED_CONCURRENCY, onError: 'collect' },
  );
  for (const { item, error } of errors) {
    deps.logger.warn(
      { profileId: item.profileId, err: error },
      'seedAccountSnapshots: per-profile seed failed (cron will repopulate on next tick)',
    );
  }
  return {
    seeded: ok.filter((o) => o === 'seeded').length,
    skipped: ok.filter((o) => o === 'skipped').length,
    failed: errors.length,
  };
};
