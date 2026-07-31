// dust-snapshot cron storage helper.
//
// `persistDust` writes the `dust-eligible` Redis key the `GET /dust-transfer`
// API route serves. The dust cron fetches Binance's dust-btc set per active
// profile and stores it here; a long TTL keeps the value visible to the
// operator across cron runs and through a transient fetch failure.

import type { Redis } from 'ioredis';
import type { AccountId, DustSnapshot, ProfileId } from '@app/contracts';
import { buildDustEligibleKey } from 'executor/redis-namespace.js';

// Dust changes slowly; hold the snapshot well past the 5-min cron interval so
// one failed fetch does not blank the operator's view.
const DUST_ELIGIBLE_TTL_S = 1_800;

export interface DustSnapshotStore {
  readonly persistDust: (
    accountId: AccountId,
    profileId: ProfileId,
    snapshot: DustSnapshot,
  ) => Promise<void>;
}

export const createDustSnapshotStore = (redis: Redis): DustSnapshotStore => ({
  persistDust: async (accountId, profileId, snapshot) => {
    await redis.set(
      buildDustEligibleKey(accountId, profileId),
      JSON.stringify(snapshot),
      'EX',
      DUST_ELIGIBLE_TTL_S,
    );
  },
});
