// Cached read of the `retention_config` singleton for the worker's hot paths.
//
// Two consumers need it: the audit shipper, which stamps `MAXLEN` onto every
// tick's XADD, and the audit drainer, which asks per pass whether deep capture
// is armed. Both run far too often to hit Postgres each time, and both only
// need freshness in seconds — an operator arming capture or widening the stream
// accepts that it starts applying on the next refresh, not the next microsecond.
//
// Failure is deliberately soft: a read that throws keeps serving the last good
// snapshot (or the seeded defaults on a cold start) and logs once per failure,
// because losing the config must not stop ticks from shipping audit entries.

import type { Logger } from 'pino';
import { repo, type Database } from '@app/db';

/** How stale a cached snapshot may get before the next read refreshes it. */
export const RETENTION_SETTINGS_TTL_MS = 15_000;

export interface RetentionSettings {
  readonly auditStreamMaxlen: number;
  /** Profile whose every tick is persisted at full fidelity right now, or null. */
  readonly debugCaptureProfileId: string | null;
}

/**
 * Cold-start / read-failure fallback. Matches the migration's seeded defaults so
 * a worker that cannot reach the config table behaves exactly like one reading
 * an untouched row, and capture stays OFF — a feature that fills the disk must
 * fail closed.
 */
const FALLBACK: RetentionSettings = { auditStreamMaxlen: 100_000, debugCaptureProfileId: null };

export interface RetentionSettingsCache {
  /** Latest snapshot, refreshed at most once per TTL. Never rejects. */
  get(): Promise<RetentionSettings>;
}

export const createRetentionSettingsCache = (deps: {
  readonly db: Database;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly clock?: { nowMs(): number };
}): RetentionSettingsCache => {
  const ttlMs = deps.ttlMs ?? RETENTION_SETTINGS_TTL_MS;
  const nowMs = (): number => (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
  let snapshot: RetentionSettings = FALLBACK;
  let readAtMs = Number.NEGATIVE_INFINITY;
  // Concurrent callers share one in-flight read rather than each issuing their
  // own; a burst of ticks arriving on an expired cache would otherwise stampede.
  let inFlight: Promise<RetentionSettings> | null = null;

  const refresh = async (): Promise<RetentionSettings> => {
    try {
      const row = await repo.retentionConfig.get(deps.db);
      // An armed window that has lapsed reads as "off" here, so nothing has to
      // run to disarm it and a worker restart cannot resurrect a stale capture.
      const armed =
        row.debugCaptureUntil !== null && row.debugCaptureUntil.getTime() > nowMs()
          ? row.debugCaptureProfileId
          : null;
      snapshot = { auditStreamMaxlen: row.auditStreamMaxlen, debugCaptureProfileId: armed };
    } catch (err) {
      deps.logger.warn({ err }, 'retention-config read failed (serving last known settings)');
    }
    readAtMs = nowMs();
    return snapshot;
  };

  return {
    async get() {
      if (nowMs() - readAtMs < ttlMs) return snapshot;
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};
