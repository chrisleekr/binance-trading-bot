import { DEFAULT_AUTH_SECURITY_SETTINGS } from '@app/contracts';
import type { Database } from '@app/db';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSecuritySettingsStore,
  SECURITY_SETTINGS_CACHE_MS,
} from '../../src/auth/security-settings.js';
import { sessionExpiry, sessionLimits } from '../../src/middleware/auth.js';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@app/db', () => ({ repo: { authSecuritySettings: { get: mocks.get } } }));

const db = {} as Database;

/**
 * A stored row as the repo returns it.
 *
 * @param settings - The raw jsonb document, unvalidated.
 * @param securityEpoch - The epoch sessions are checked against.
 * @param agentAccessNotBefore - The agent-token cutoff, or null when agent access was never revoked.
 * @returns The row shape `repo.authSecuritySettings.get` resolves to.
 */
const row = (
  settings: unknown,
  securityEpoch: number,
  agentAccessNotBefore: Date | null = null,
): Record<string, unknown> => ({
  id: 1,
  settings,
  securityEpoch,
  agentAccessNotBefore,
  updatedAt: new Date(0),
});

/**
 * A logger whose `error` calls the test can inspect.
 *
 * @returns The logger and its `error` spy.
 */
const spyLogger = (): { logger: Logger; error: ReturnType<typeof vi.fn> } => {
  const error = vi.fn();
  return { logger: { error } as unknown as Logger, error };
};

describe('security settings store', () => {
  let t: number;
  const now = (): number => t;

  beforeEach(() => {
    t = 1_000_000;
    mocks.get.mockReset();
  });

  it('replaces an out-of-range stored document with the strict defaults and logs why', async () => {
    const { logger, error } = spyLogger();
    mocks.get.mockResolvedValueOnce(
      row({ signInAttemptsPerIpAddress: { maximumAttempts: 10_000, periodSeconds: 1 } }, 7),
    );
    const store = createSecuritySettingsStore(db, logger, now);
    const snapshot = await store.get();
    expect(snapshot.settings).toEqual(DEFAULT_AUTH_SECURITY_SETTINGS);
    expect(snapshot.securityEpoch).toBe(7);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      'auth_security_settings_invalid_using_defaults',
    );
  });

  it('keeps the last known epoch with default settings when a later read fails', async () => {
    const { logger, error } = spyLogger();
    mocks.get
      .mockResolvedValueOnce(
        row({ signInAttemptsPerIpAddress: { maximumAttempts: 2, periodSeconds: 600 } }, 4),
      )
      .mockRejectedValueOnce(new Error('database down'));
    const store = createSecuritySettingsStore(db, logger, now);
    expect((await store.get()).settings.signInAttemptsPerIpAddress.maximumAttempts).toBe(2);
    t += SECURITY_SETTINGS_CACHE_MS;
    const degraded = await store.get();
    expect(degraded).toEqual({
      settings: DEFAULT_AUTH_SECURITY_SETTINGS,
      securityEpoch: 4,
      degraded: true,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'auth_security_settings_read_failed_using_defaults',
    );
  });

  it('reuses a read for the cache lifetime and reads again once it has passed', async () => {
    mocks.get.mockResolvedValueOnce(row({}, 1)).mockResolvedValueOnce(row({}, 2));
    const store = createSecuritySettingsStore(db, spyLogger().logger, now);
    expect((await store.get()).securityEpoch).toBe(1);
    t += SECURITY_SETTINGS_CACHE_MS - 1;
    expect((await store.get()).securityEpoch).toBe(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    t += 1;
    expect((await store.get()).securityEpoch).toBe(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next get() to read the database', async () => {
    mocks.get.mockResolvedValueOnce(row({}, 1)).mockResolvedValueOnce(row({}, 2));
    const store = createSecuritySettingsStore(db, spyLogger().logger, now);
    expect((await store.get()).securityEpoch).toBe(1);
    store.invalidate();
    expect((await store.get()).securityEpoch).toBe(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('a read that started before invalidate() does not put its snapshot back into the cache', async () => {
    let finishStaleRead: (value: unknown) => void = () => {};
    mocks.get
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishStaleRead = resolve;
        }),
      )
      .mockResolvedValueOnce(row({}, 2))
      .mockResolvedValueOnce(row({}, 3));
    const store = createSecuritySettingsStore(db, spyLogger().logger, now);
    const staleRead = store.get();
    // The write this invalidate follows landed after the pending read fetched its row.
    store.invalidate();
    finishStaleRead(row({}, 1));
    expect((await staleRead).securityEpoch).toBe(1);
    // Had the stale snapshot been cached, this would answer 1 without reading.
    expect((await store.get()).securityEpoch).toBe(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('session limits on a degraded snapshot', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 9, 3);
  // Two days old and idle for twelve hours: past the strict fallback (24 h / 8 h) but inside limits an operator may choose (168 h / 24 h).
  const session = {
    createdAt: new Date(now - 48 * HOUR),
    updatedAt: new Date(now - 12 * HOUR),
    securityEpoch: 4,
  };

  it('does not end a session on the fallback limits after a failed read', () => {
    const limits = sessionLimits({
      settings: DEFAULT_AUTH_SECURITY_SETTINGS,
      securityEpoch: 4,
      degraded: true,
    });
    expect(sessionExpiry(session, limits, now)).toBeNull();
  });

  it('still ends a session issued before the last known epoch', () => {
    const limits = sessionLimits({
      settings: DEFAULT_AUTH_SECURITY_SETTINGS,
      securityEpoch: 5,
      degraded: true,
    });
    expect(sessionExpiry(session, limits, now)).toBe('session-invalidated');
  });

  it('enforces the same limits when they were actually read', () => {
    const limits = sessionLimits({ settings: DEFAULT_AUTH_SECURITY_SETTINGS, securityEpoch: 4 });
    expect(sessionExpiry(session, limits, now)).toBe('session-expired-absolute');
  });
});
