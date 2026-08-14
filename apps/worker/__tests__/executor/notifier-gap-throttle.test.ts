import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createNotifierGapThrottle,
  createOrderFailedThrottle,
  createProtectiveStopBlockedThrottle,
  DEFAULT_NOTIFIER_GAP_WINDOW_MS,
  createSymbolNotPermittedThrottle,
  DEFAULT_ORDER_FAILED_WINDOW_MS,
  DEFAULT_PROTECTIVE_STOP_BLOCKED_WINDOW_MS,
  DEFAULT_SYMBOL_NOT_PERMITTED_WINDOW_MS,
  ORDER_FAILED_KEY_PREFIX,
  ORDER_UNFUNDABLE_KEY_PREFIX,
  PROTECTIVE_STOP_BLOCKED_KEY_PREFIX,
  SYMBOL_NOT_PERMITTED_KEY_PREFIX,
} from '../../src/executor/notifier-gap-throttle.js';
import * as throttles from '../../src/executor/notifier-gap-throttle.js';
import * as reconcileEnqueue from '../../src/executor/reconcile-enqueue.js';
import * as discoveryHealth from '../../src/crons/discovery-health.cron.js';

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

describe('createSymbolNotPermittedThrottle', () => {
  it('has its OWN key namespace and a one-hour window', async () => {
    // Keyed per (profile, symbol) and hourly because the refusal is PERMANENT:
    // unlike a wallet shortfall, nothing the bot does clears it, so the
    // re-emission is unbounded in time rather than merely long.
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createSymbolNotPermittedThrottle({ redis, logger: fakeLogger() });

    expect(await t.allow('p-1:CRCLBUSDT')).toBe(true);

    expect(set).toHaveBeenCalledWith(
      `${SYMBOL_NOT_PERMITTED_KEY_PREFIX}p-1:CRCLBUSDT`,
      '1',
      'PX',
      DEFAULT_SYMBOL_NOT_PERMITTED_WINDOW_MS,
      'NX',
    );
    expect(DEFAULT_SYMBOL_NOT_PERMITTED_WINDOW_MS).toBe(3_600_000);
  });

  it('does not share a namespace with the unfundable throttle', async () => {
    // The two refusals have different causes and different fixes ("free up the
    // wallet" vs "the account can never trade this"), so suppressing one must
    // never suppress the other. Equal windows make a shared prefix easy to miss.
    expect(SYMBOL_NOT_PERMITTED_KEY_PREFIX).not.toBe(ORDER_UNFUNDABLE_KEY_PREFIX);
  });
});

describe('createProtectiveStopBlockedThrottle', () => {
  // C6. An unplaceable protective stop is now DEFERRED rather than attempted, so
  // it raises no placement refusal and reaches none of the prefixes above. It
  // repeats on exactly the same cadence though — the band is re-evaluated every
  // tick and refuses the same way — so it needs the same suppression window on a
  // namespace of its own.
  it('C6: raises under its own key namespace, so no other alert cause can mute it', async () => {
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createProtectiveStopBlockedThrottle({ redis, logger: fakeLogger() });

    expect(await t.allow('p-1:LINKUSDT:terminal')).toBe(true);

    expect(set).toHaveBeenCalledWith(
      `${PROTECTIVE_STOP_BLOCKED_KEY_PREFIX}p-1:LINKUSDT:terminal`,
      '1',
      'PX',
      DEFAULT_PROTECTIVE_STOP_BLOCKED_WINDOW_MS,
      'NX',
    );
    expect(PROTECTIVE_STOP_BLOCKED_KEY_PREFIX).toBe('protective-stop-blocked-throttle:');
  });

  it('C6: a persistent refusal cannot suppress the terminal one on the same coin', async () => {
    // Same split as the order-failed retry/final levels. The persistent alert says
    // "the price has to come back"; the terminal one says "no price ever arms this
    // stop, widen the offset". Same profile, same symbol, opposite advice.
    const set = vi.fn<Redis['set']>().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const t = createProtectiveStopBlockedThrottle({ redis, logger: fakeLogger() });

    expect(await t.allow('p-1:LINKUSDT:persistent')).toBe(true);
    expect(await t.allow('p-1:LINKUSDT:terminal')).toBe(true);
    expect(set.mock.calls.map((c) => c[0])).toEqual([
      `${PROTECTIVE_STOP_BLOCKED_KEY_PREFIX}p-1:LINKUSDT:persistent`,
      `${PROTECTIVE_STOP_BLOCKED_KEY_PREFIX}p-1:LINKUSDT:terminal`,
    ]);
  });
});

describe('per-(profile, symbol) throttle namespaces', () => {
  it('gives every (profile, symbol) window its own prefix', () => {
    // Every window here is keyed on `${profileId}:${symbol}`, some with a further
    // escalation suffix, so a duplicated prefix is a duplicated Redis key and
    // whichever cause fires first mutes the rest for the whole window. Nothing
    // else would catch that: each throttle passes its own unit tests while
    // silently sharing a key with a sibling.
    //
    // ENUMERATED from every module that owns one, never hand-listed: a
    // hand-written set stops covering the moment someone adds a prefix without
    // editing this test, which is exactly when the guard is needed.
    //
    // Matched on the VALUE, not the export name: a prefix named off-convention
    // would escape a name filter while still colliding in Redis, and the name is
    // not what shares the keyspace.
    const prefixes = [throttles, reconcileEnqueue, discoveryHealth]
      .flatMap((m) => Object.values(m))
      .filter((v): v is string => typeof v === 'string' && /^[a-z0-9-]+-throttle:$/.test(v));
    // A walk that finds nothing would pass the set-size assertion vacuously.
    expect(prefixes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
