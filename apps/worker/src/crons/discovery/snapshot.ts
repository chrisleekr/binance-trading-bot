// Best-effort discovery universe-snapshot write.

import type { Logger } from 'pino';
import type { DiscoveryUniverseSnapshotPayload } from '@app/db';

/**
 * Best-effort discovery-snapshot write (#436). A snapshot is pure observability
 * for a future backtest, so a write failure must NOT churn the symbol set or
 * abort the cycle: it is logged at warn and swallowed, never rethrown. Extracted
 * from the cron port so the swallow path is unit-testable without a live Postgres.
 */
export const persistSnapshotBestEffort = async (
  record: (snapshot: DiscoveryUniverseSnapshotPayload) => Promise<unknown>,
  logger: Logger,
  profileId: string,
  snapshot: DiscoveryUniverseSnapshotPayload,
): Promise<void> => {
  try {
    await record(snapshot);
  } catch (err) {
    logger.warn(
      { profileId, err: err },
      'cron discovery: universe-snapshot write failed (cycle continues)',
    );
  }
};
