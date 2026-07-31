import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createNotifierGapThrottle,
  createOrderFailedThrottle,
  DEFAULT_NOTIFIER_GAP_WINDOW_MS,
  DEFAULT_ORDER_FAILED_WINDOW_MS,
  ORDER_FAILED_KEY_PREFIX,
} from '../../src/executor/notifier-gap-throttle.js';

const fakeLogger = () => ({ warn: vi.fn() }) as unknown as Logger;

describe('createNotifierGapThrottle', () => {
  it('allows when Redis SET NX succeeds and suppresses when it is already set', async () => {
    // 'OK' → key was absent (window opened); null → key present (suppressed).
    const set = vi.fn<Redis['set']>().mockResolvedValueOnce('OK').mockResolvedValue(null);
    const redis = { set } as unknown as Redis;
    const t = createNotifierGapThrottle({ redis, logger: fakeLogger(), windowMs: 1000 });

    expect(await t.allow('p-1:emergency')).toBe(true);
    expect(await t.allow('p-1:emergency')).toBe(false);
  });

  it('issues a namespaced SET with NX and the window as the PX TTL', async () => {
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createNotifierGapThrottle({ redis, logger: fakeLogger(), windowMs: 5000 });

    await t.allow('p-1:emergency');

    expect(set).toHaveBeenCalledWith('notifier-gap-throttle:p-1:emergency', '1', 'PX', 5000, 'NX');
  });

  it('defaults to the one-hour window', async () => {
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createNotifierGapThrottle({ redis, logger: fakeLogger() });

    await t.allow('k');

    expect(set).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      'PX',
      DEFAULT_NOTIFIER_GAP_WINDOW_MS,
      'NX',
    );
  });

  it('fails open and logs when Redis is unavailable', async () => {
    const set = vi.fn<Redis['set']>().mockRejectedValue(new Error('ECONNREFUSED'));
    const redis = { set } as unknown as Redis;
    const logger = fakeLogger();
    const t = createNotifierGapThrottle({ redis, logger });

    expect(await t.allow('k')).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('fails open when Redis rejects with a non-Error value', async () => {
    // Exercises the `String(err)` branch of the warn payload.
    const set = vi.fn<Redis['set']>().mockRejectedValue('ECONNREFUSED');
    const redis = { set } as unknown as Redis;
    const logger = fakeLogger();
    const t = createNotifierGapThrottle({ redis, logger });

    expect(await t.allow('k')).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('fails open when the Redis SET stalls past the timeout', async () => {
    // A reachable-but-stalled Redis: the SET never settles. The deadline race
    // must reject into the fail-open path instead of hanging the caller.
    const set = vi.fn<Redis['set']>().mockReturnValue(new Promise(() => {}));
    const redis = { set } as unknown as Redis;
    const logger = fakeLogger();
    const t = createNotifierGapThrottle({ redis, logger, setTimeoutMs: 10 });

    expect(await t.allow('k')).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  // `release` had no failure coverage at all: every test above exercises `allow`. It runs
  // on the tick path and is deadline-bounded for the same reason, so both of its failure
  // shapes need pinning. The window self-expires on its PX TTL, which is what lets a lost
  // DEL degrade to a warn rather than a failed notification.
  it('release resolves and warns when the DEL throws SYNCHRONOUSLY', async () => {
    // NOT async: an async stub would produce the rejection covered below, not the throw
    // that used to escape the deadline guard and surface as a failed tick.
    const del = vi.fn((): never => {
      throw new Error('Connection is closed');
    });
    const redis = { del } as unknown as Redis;
    const logger = fakeLogger();
    const t = createNotifierGapThrottle({ redis, logger });

    await expect(t.release('k')).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith('notifier-gap-throttle:k');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('release resolves and warns when the DEL rejects', async () => {
    const del = vi.fn<Redis['del']>().mockRejectedValue(new Error('ECONNREFUSED'));
    const redis = { del } as unknown as Redis;
    const logger = fakeLogger();
    const t = createNotifierGapThrottle({ redis, logger });

    await expect(t.release('k')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('createOrderFailedThrottle', () => {
  it('has its OWN key namespace and a 15-minute window', async () => {
    // Its own prefix: sharing the notifier-gap namespace would let one signal
    // suppress the other. Its own window: the spam vector is one symbol failing the
    // same way tick after tick, so the window must span several tick periods.
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createOrderFailedThrottle({ redis, logger: fakeLogger() });

    expect(await t.allow('p-1:BTCUSDT:final')).toBe(true);

    expect(set).toHaveBeenCalledWith(
      `${ORDER_FAILED_KEY_PREFIX}p-1:BTCUSDT:final`,
      '1',
      'PX',
      DEFAULT_ORDER_FAILED_WINDOW_MS,
      'NX',
    );
    expect(DEFAULT_ORDER_FAILED_WINDOW_MS).toBe(900_000);
  });

  it('a benign retryable failure cannot suppress the dangerous non-retryable one', async () => {
    // The two alerts say opposite things ("it will try again" vs "the position is
    // UNGUARDED"), so the escalation level is part of the key. Same profile, same
    // symbol, different level ⇒ both get through.
    const set = vi.fn<Redis['set']>().mockResolvedValueOnce('OK').mockResolvedValueOnce('OK');
    const redis = { set } as unknown as Redis;
    const t = createOrderFailedThrottle({ redis, logger: fakeLogger() });

    expect(await t.allow('p-1:BTCUSDT:retry')).toBe(true);
    expect(await t.allow('p-1:BTCUSDT:final')).toBe(true);
    expect(set.mock.calls.map((c) => c[0])).toEqual([
      `${ORDER_FAILED_KEY_PREFIX}p-1:BTCUSDT:retry`,
      `${ORDER_FAILED_KEY_PREFIX}p-1:BTCUSDT:final`,
    ]);
  });
});
