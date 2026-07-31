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

/** Tolerant parse of a raw stored `discovery_config`: malformed parses to null (disabled). */
export const parseDiscoveryConfig = (raw: unknown): StoredDiscoveryConfig | null => {
  const parsed = DiscoveryConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : null;
};
