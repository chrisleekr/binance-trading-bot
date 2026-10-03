import { AuthSecuritySettings, DEFAULT_AUTH_SECURITY_SETTINGS } from '@app/contracts';
import { repo, type Database } from '@app/db';
import type { Logger } from 'pino';

/** The effective protection settings plus the epoch sessions are checked against. */
export interface SecuritySnapshot {
  readonly settings: AuthSecuritySettings;
  readonly securityEpoch: number;
}

/** Cached access to the operator's sign-in protection settings. */
export interface SecuritySettingsStore {
  /** The current snapshot, at most {@link SECURITY_SETTINGS_CACHE_MS} old. Never throws. */
  get(): Promise<SecuritySnapshot>;
  /** Drops the cache so the next read sees a write this process just made. Other replicas converge within the cache lifetime. */
  invalidate(): void;
}

/** How long a read is reused. Short enough that a tightened limit or a sign-out-everywhere reaches every replica within half a minute. */
export const SECURITY_SETTINGS_CACHE_MS = 30_000;

/**
 * Builds the settings store.
 *
 * Every read is validated against the contract's hard ranges. A stored document that fails validation (edited by hand, or written by an older release) is replaced by the strict defaults rather than obeyed, and a database outage also yields the defaults with the last known epoch, so no failure mode loosens protection.
 *
 * @param db - Database handle.
 * @param logger - Where validation and read failures are reported.
 * @param now - Clock, injectable for tests.
 * @returns The store.
 */
export const createSecuritySettingsStore = (
  db: Database,
  logger: Logger,
  now: () => number = Date.now,
): SecuritySettingsStore => {
  let cached: { snapshot: SecuritySnapshot; at: number } | null = null;
  let lastEpoch = 0;
  // Advanced by invalidate(). A read that started before an invalidate may have fetched the row before the write it follows, so it must not put that snapshot back into the cache.
  let generation = 0;
  return {
    async get() {
      if (cached !== null && now() - cached.at < SECURITY_SETTINGS_CACHE_MS) return cached.snapshot;
      const startedAt = generation;
      try {
        const row = await repo.authSecuritySettings.get(db);
        const parsed = AuthSecuritySettings.safeParse(row.settings ?? {});
        if (!parsed.success) {
          logger.error(
            { issues: parsed.error.issues },
            'auth_security_settings_invalid_using_defaults',
          );
        }
        const snapshot: SecuritySnapshot = {
          settings: parsed.success ? parsed.data : DEFAULT_AUTH_SECURITY_SETTINGS,
          securityEpoch: row.securityEpoch,
        };
        if (startedAt === generation) {
          lastEpoch = snapshot.securityEpoch;
          cached = { snapshot, at: now() };
        }
        return snapshot;
      } catch (err) {
        logger.error({ err }, 'auth_security_settings_read_failed_using_defaults');
        return {
          settings: DEFAULT_AUTH_SECURITY_SETTINGS,
          securityEpoch: lastEpoch,
        };
      }
    },
    invalidate() {
      generation += 1;
      cached = null;
    },
  };
};
