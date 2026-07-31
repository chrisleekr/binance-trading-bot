import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import type { AccountId, ProfileId, UserId } from '@app/contracts';

const repoMocks = vi.hoisted(() => ({ append: vi.fn() }));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: vi.fn(async () => ({ actionLogs: { append: repoMocks.append } })),
  };
});

import {
  createStreamSilenceHandler,
  recordStreamSilence,
} from '../../src/user-stream/stream-silence-trace.js';

const USER = 'u1' as unknown as UserId;
const ACCOUNT = 'a1' as unknown as AccountId;
const PROFILE = 'p1' as unknown as ProfileId;

const fakeLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

const deps = (allow: boolean) => ({
  db: {} as never,
  logger: fakeLogger,
  notifierGapThrottle: { allow: vi.fn(async () => allow), release: vi.fn(async () => undefined) },
});

const AGE_MS = 45 * 60_000;

describe('recordStreamSilence', () => {
  it('writes ONE warn-level action_log with the stream-silent topic when the throttle allows', async () => {
    // The operator-visible half of the idle watchdog. The reconnect happens either
    // way; this row is the only thing that tells the operator their stream went
    // quiet and the bot went to check. A throttle-key typo or a wrong level would
    // ship green and the operator gets exactly the silence the feature exists to
    // break.
    repoMocks.append.mockReset().mockResolvedValue(undefined);
    const d = deps(true);

    await recordStreamSilence(d, USER, ACCOUNT, PROFILE, AGE_MS);

    expect(d.notifierGapThrottle.allow).toHaveBeenCalledWith(`${PROFILE}:stream-silent`);
    expect(repoMocks.append).toHaveBeenCalledTimes(1);
    const row = repoMocks.append.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      level: 'warn',
      symbol: null,
      ctx: { topic: 'stream-silent', ageMs: AGE_MS },
    });
    // Plain language, and it does NOT claim the stream is broken: Binance emits an
    // account event only on a balance change, so silence is not itself a fault.
    expect(row.msg).toContain('45 minutes');
  });

  it('writes NOTHING when the throttle denies — a quiet profile must not flood the feed', async () => {
    repoMocks.append.mockReset().mockResolvedValue(undefined);
    const d = deps(false);

    await recordStreamSilence(d, USER, ACCOUNT, PROFILE, AGE_MS);

    expect(repoMocks.append).not.toHaveBeenCalled();
  });

  it('is best-effort: a failing append resolves and logs, it does not throw', async () => {
    // The caller is the watchdog callback; the reconnect + reconcile it goes on to
    // do is the part that protects money. Losing the visibility row must not abort
    // them — but it must not be silent either.
    repoMocks.append.mockReset().mockRejectedValue(new Error('pg down'));
    const d = deps(true);

    await expect(recordStreamSilence(d, USER, ACCOUNT, PROFILE, AGE_MS)).resolves.toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });
});

describe('createStreamSilenceHandler', () => {
  it('fans out ONE stream-silent reconcile per symbol on the profile', async () => {
    // A half-dead stream could have swallowed a fill on ANY of the profile's
    // symbols — there is no way to know which — so every one must be converged.
    repoMocks.append.mockReset().mockResolvedValue(undefined);
    const enqueueSymbolReconcile = vi.fn(async () => undefined);
    const handler = createStreamSilenceHandler({
      ...deps(true),
      symbolsOf: () => ['BTCUSDT', 'ETHUSDT'],
      enqueueSymbolReconcile,
    });

    await handler(USER, ACCOUNT, PROFILE, AGE_MS);

    expect(enqueueSymbolReconcile).toHaveBeenCalledTimes(2);
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      expect(enqueueSymbolReconcile).toHaveBeenCalledWith({
        accountId: ACCOUNT,
        profileId: PROFILE,
        symbol,
        cause: 'stream-silent',
      });
    }
  });

  it('a failing enqueue does not abort the remaining symbols', async () => {
    // The pool has already reconnected; one bad enqueue must not cost the other
    // symbols their converge pass. The backstop cron catches whatever is dropped.
    repoMocks.append.mockReset().mockResolvedValue(undefined);
    const enqueueSymbolReconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);
    const handler = createStreamSilenceHandler({
      ...deps(true),
      symbolsOf: () => ['BTCUSDT', 'ETHUSDT'],
      enqueueSymbolReconcile,
    });

    await expect(handler(USER, ACCOUNT, PROFILE, AGE_MS)).resolves.toBeUndefined();
    expect(enqueueSymbolReconcile).toHaveBeenCalledTimes(2);
  });

  it('enqueues nothing for a profile that is no longer active', async () => {
    repoMocks.append.mockReset().mockResolvedValue(undefined);
    const enqueueSymbolReconcile = vi.fn(async () => undefined);
    const handler = createStreamSilenceHandler({
      ...deps(true),
      symbolsOf: () => [],
      enqueueSymbolReconcile,
    });

    await handler(USER, ACCOUNT, PROFILE, AGE_MS);

    expect(enqueueSymbolReconcile).not.toHaveBeenCalled();
  });
});
