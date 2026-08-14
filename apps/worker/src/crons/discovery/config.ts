// Discovery config projection + resync request.
//
// Pure, dependency-light helpers over the stored discovery config: the tolerant
// parse, the cron-only-field strip to the pure-chain shape, and the resync
// request payload. No I/O, so the whole surface is unit-testable without a DB.

import { DiscoveryConfigSchema, type StoredDiscoveryConfig } from '@app/contracts';
import type { DiscoveryConfig } from '@app/discovery';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { ReconfigureProfileRequest } from 'queues/reconfigure-enqueue.js';

/**
 * The resync request for a profile. Reads `operatorId` (the ownership root the
 * pipeline keys on), not `userId`, and carries `accountId` — parseProfileJob
 * rejects a payload missing any of the three, failing the job to the DLQ rather
 * than no-oping the resync.
 */
export const discoveryResyncRequest = (p: ActiveProfile): ReconfigureProfileRequest => ({
  userId: p.operatorId,
  accountId: p.accountId,
  profileId: p.profileId,
});

/**
 * Strip the cron-only fields (`enabled`, `refreshPeriodMs`) to the pure-chain
 * config. `quoteAsset` is no longer part of the stored discovery config; it is
 * the profile's first-class column, threaded in here so the pure filter chain
 * still receives its quote target.
 */
export const toPureConfig = (c: StoredDiscoveryConfig, quoteAsset: string): DiscoveryConfig => ({
  quoteAsset,
  blacklist: c.blacklist,
  min24hPairVolumeUsd: c.min24hPairVolumeUsd,
  min24hAssetVolumeUsd: c.min24hAssetVolumeUsd,
  maxSpreadRatio: c.maxSpreadRatio,
  changeMinPercent: c.changeMinPercent,
  rankTopPercent: c.rankTopPercent,
  rankExcludeTopPercent: c.rankExcludeTopPercent,
  minAgeDays: c.minAgeDays,
  maxAutoSymbols: c.maxAutoSymbols,
  minHoldMinutes: c.minHoldMinutes,
  marketBreadthMinPercent: c.marketBreadthMinPercent,
  trendConfirm: { ...c.trendConfirm },
  correlation: { ...c.correlation },
});

/**
 * Outcome of reading a profile's stored `discovery_config`.
 *
 * Discriminated rather than nullable because the two failure modes look
 * identical from the outside and are not: a DISABLED profile is doing what the
 * operator asked, while a MALFORMED one is broken and nobody has been told. Both
 * used to parse to `null` and skip the profile silently, so a corrupt config
 * presented as a profile that simply never trades.
 */
export type DiscoveryConfigParse =
  | { readonly ok: true; readonly cfg: StoredDiscoveryConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Tolerant parse of a raw stored `discovery_config`; absent parses to defaults (disabled). */
export const parseDiscoveryConfig = (raw: unknown): DiscoveryConfigParse => {
  const parsed = DiscoveryConfigSchema.safeParse(raw ?? {});
  return parsed.success
    ? { ok: true, cfg: parsed.data }
    : {
        ok: false,
        issues: parsed.error.issues.map(
          (i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`,
        ),
      };
};
