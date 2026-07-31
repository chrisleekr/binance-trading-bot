import { describe, expect, it, vi } from 'vitest';
import { profileKey, type ProfileScope } from '@app/db';
import { asAccountId, asProfileId, asUserId, type ManualOverridePayload } from '@app/contracts';

import { settleOverride } from '../../src/tick/override-settlement.js';

const OPERATOR = asUserId('00000000-0000-0000-0000-0000000000a1');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-000000000abc');
const PROFILE = asProfileId('00000000-0000-0000-0000-000000000def');
const SYMBOL = 'BTCUSDT';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';

// The ownership the tick already proved and hands straight to the settle.
const SCOPE = {
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
} as unknown as ProfileScope;

const OVERRIDE: ManualOverridePayload = {
  kind: 'trigger-sell',
  overrideActionId: OVERRIDE_ACTION_ID,
};

// The bytes the bundle-builder DEL'd and the re-arm must restore.
const OVERRIDE_KEY = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);

/** The `processing_at` stamp a claiming tick would have written, and the release's fence. */
const CLAIM_AT = new Date('2026-07-30T00:00:00.000Z');

/**
 * ioredis stub recording every `set` argv. `rejectSet` forces the SET to
 * reject so the "re-arm failed" path is exercisable: a Redis failure here
 * must never surface as a thrown tick.
 */
const buildFakeRedis = (
  setCalls: unknown[][],
  rejectSet = false,
  // ioredis resolves SET..NX to null when the key already exists — the operator
  // pushed a newer override in the DEL→settle gap.
  setReply: 'OK' | null = 'OK',
): import('ioredis').Redis =>
  ({
    set: (...argv: unknown[]): Promise<'OK' | null> => {
      setCalls.push(argv);
      return rejectSet ? Promise.reject(new Error('redis down')) : Promise.resolve(setReply);
    },
  }) as unknown as import('ioredis').Redis;

const buildFakeLogger = (warnings: { ctx: unknown; msg: string }[]): import('pino').Logger =>
  ({
    warn: (ctx: unknown, msg: string) => {
      warnings.push({ ctx, msg });
    },
  }) as unknown as import('pino').Logger;

/**
 * `settleOverride` decides the fate of an override the bundle-builder already
 * DEL'd from Redis: consume it (mark the audit row done), or — when the
 * strategy declined to act on it this tick — re-arm the Redis key so the
 * operator's intent survives to the next tick. Getting this wrong loses a
 * force-sell silently, so each branch is asserted directly.
 */
describe('settleOverride', () => {
  it('re-arms with NX+PX and does not mark consumed when deferred', async () => {
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(settleOverrideAction).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.[0]).toBe(OVERRIDE_KEY);
    expect(JSON.parse(String(setCalls[0]?.[1]))).toEqual(OVERRIDE);
  });

  it('marks consumed and does not re-arm when the strategy applied the override', async () => {
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: false,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    // The outcome rides with the settle: a row marked done with no outcome is
    // exactly what let a refused override read as a success.
    expect(settleOverrideAction).toHaveBeenCalledWith(SCOPE, OVERRIDE_ACTION_ID, {
      status: 'rejected',
      reason: expect.any(String) as unknown as string,
    });
  });

  it('uses NX so a newer override written after the DEL is not clobbered', async () => {
    const setCalls: unknown[][] = [];

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction: vi.fn(async () => {}),
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 90_000,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(1);
    // Exact argv: key, value, PX <remaining-ttl>, NX. PX preserves the operator's
    // original expiry window; NX yields to a fresher override the operator pushed
    // between the DEL and this re-arm.
    expect(setCalls[0]).toEqual([OVERRIDE_KEY, JSON.stringify(OVERRIDE), 'PX', 90_000, 'NX']);
  });

  it('consumes without re-arming when remaining TTL is exhausted or unavailable', async () => {
    for (const ttlMs of [0, -1, undefined]) {
      const setCalls: unknown[][] = [];
      const settleOverrideAction = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger([]),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      expect(setCalls, `ttlMs=${String(ttlMs)}`).toHaveLength(0);
      expect(settleOverrideAction, `ttlMs=${String(ttlMs)}`).toHaveBeenCalledTimes(1);
    }
  });

  it('consumes an unsupported kind without re-arming', async () => {
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    // An override the strategy does not declare can never be applied; re-arming
    // it would loop it forever. Consume it, same as today.
    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: true,
      supported: false,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    // Only an explicit `false` earns the negative claim.
    expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'rejected',
      reason: 'this strategy does not support this action',
    });
  });

  it('does not claim the action is unsupported when the caller could not establish it', async () => {
    // `supported` has three states, and absent is "not established". A caller with
    // no view of `strategy.capabilities` must not have the NEGATIVE assertion put in
    // its mouth: the neutral wording is true whatever the capability turns out to be.
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: true,
      orderFate: { kind: 'none' },
    });

    // Absent `supported` also means the defer cannot re-arm: unestablished is not
    // permission.
    expect(setCalls).toHaveLength(0);
    expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'rejected',
      reason: 'the strategy did not act on this override',
    });
  });

  it('warns and completes when the re-arm SET rejects', async () => {
    const setCalls: unknown[][] = [];
    const warnings: { ctx: unknown; msg: string }[] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await expect(
      settleOverride({
        redis: buildFakeRedis(setCalls, true),
        logger: buildFakeLogger(warnings),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      }),
    ).resolves.toBeUndefined();

    expect(setCalls).toHaveLength(1);
    // A failed re-arm must not fall through to consuming: the DB row stays
    // pending so the operator still sees the override as un-executed.
    expect(settleOverrideAction).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });

  it('resolves and warns when settleOverrideAction throws synchronously', async () => {
    const warnings: { ctx: unknown; msg: string }[] = [];
    const boom = new Error('row writer exploded');
    // Deliberately NOT async: the deadline race only ever receives an already-built
    // promise, so a throw raised before that promise exists is the one shape that
    // can escape it.
    const settleOverrideAction = vi.fn(() => {
      throw boom;
    });

    await expect(
      settleOverride({
        redis: buildFakeRedis([]),
        logger: buildFakeLogger(warnings),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        // A deadline far past vitest's 5s test timeout: this can only pass if the
        // failure short-circuits the race instead of waiting the budget out.
        persistTimeoutMs: 60_000,
        deferred: false,
        supported: true,
        orderFate: { kind: 'none' },
      }),
    ).resolves.toBeUndefined();

    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    // Same diagnostic as an async rejection: a swallowed settle failure is a row
    // the operator sees as pending forever with nothing in the log to explain it.
    const failed = warnings.find((w) => w.msg.includes('settleOverrideAction failed'));
    expect(failed).toBeDefined();
    expect(failed?.ctx).toMatchObject({ err: boom });
  });

  it('resolves and warns when settleOverrideAction rejects', async () => {
    // The sync throw above and this rejection reach the SAME handler, so both are
    // pinned: with only one asserted, a regression on the other hides behind it.
    const warnings: { ctx: unknown; msg: string }[] = [];
    const boom = new Error('row writer rejected');
    const settleOverrideAction = vi.fn(() => Promise.reject(boom));

    await expect(
      settleOverride({
        redis: buildFakeRedis([]),
        logger: buildFakeLogger(warnings),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        // Far past vitest's 5s timeout: only a short-circuit on the rejection passes.
        persistTimeoutMs: 60_000,
        deferred: false,
        supported: true,
        orderFate: { kind: 'none' },
      }),
    ).resolves.toBeUndefined();

    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    const failed = warnings.find((w) => w.msg.includes('settleOverrideAction failed'));
    expect(failed).toBeDefined();
    expect(failed?.ctx).toMatchObject({ err: boom });
  });

  it('resolves and warns when the ambiguous-outcome notify throws synchronously', async () => {
    const warnings: { ctx: unknown; msg: string }[] = [];
    const boom = new Error('notifier exploded');
    const settleOverrideAction = vi.fn(async () => {});
    const notifyOverrideOutcome = vi.fn(() => {
      throw boom;
    });

    await expect(
      settleOverride({
        redis: buildFakeRedis([]),
        logger: buildFakeLogger(warnings),
        settleOverrideAction,
        notifyOverrideOutcome,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: false,
        supported: true,
        // `unknown` is the only outcome that escalates to the operator, and an
        // ambiguous failure is the only fate that produces it.
        orderFate: {
          kind: 'failed',
          result: { ok: false, retryable: true, phase: 'ambiguous', reason: 'socket hang up' },
        },
      }),
    ).resolves.toBeUndefined();

    // The notify is fire-and-forget, so its warn lands independently of the settle
    // write. Poll for it rather than draining a fixed number of microtasks, which
    // would couple the assertion to the wrapper's internal scheduling.
    const failed = await vi.waitFor(() => {
      const w = warnings.find((x) => x.msg.includes('could not notify the operator'));
      expect(w).toBeDefined();
      return w;
    });
    expect(failed?.ctx).toMatchObject({ err: boom });
    // A broken notifier must not cost the durable record: the row still settles.
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'unknown',
      reason: 'socket hang up',
    });
  });

  it('resolves and warns when the ambiguous-outcome notify rejects', async () => {
    // The sync throw above and this rejection reach the SAME handler, so both are
    // pinned: with only one asserted, a regression on the other hides behind it.
    // The notifier is the likelier of the two to reject, since it fans out to
    // Postgres and outbound webhooks.
    const warnings: { ctx: unknown; msg: string }[] = [];
    const boom = new Error('notifier rejected');
    const settleOverrideAction = vi.fn(async () => {});
    const notifyOverrideOutcome = vi.fn(() => Promise.reject(boom));

    await expect(
      settleOverride({
        redis: buildFakeRedis([]),
        logger: buildFakeLogger(warnings),
        settleOverrideAction,
        notifyOverrideOutcome,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: false,
        supported: true,
        orderFate: {
          kind: 'failed',
          result: { ok: false, retryable: true, phase: 'ambiguous', reason: 'socket hang up' },
        },
      }),
    ).resolves.toBeUndefined();

    const failed = await vi.waitFor(() => {
      const w = warnings.find((x) => x.msg.includes('could not notify the operator'));
      expect(w).toBeDefined();
      return w;
    });
    expect(failed?.ctx).toMatchObject({ err: boom });
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('consumes the stale row when NX loses to a newer override', async () => {
    // ioredis answers null when NX refused the write: the operator pushed a fresher
    // override into the key after the DEL. The fresh intent wins, so the stale row
    // can never execute — consume it instead of leaving it pending forever.
    const setCalls: unknown[][] = [];
    const warnings: { ctx: unknown; msg: string }[] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls, false, null),
      logger: buildFakeLogger(warnings),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(1);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({ status: 'superseded' });
    expect(warnings.some((w) => /superseded/.test(w.msg))).toBe(true);
  });

  it('does not consume when the re-arm actually took the key', async () => {
    // Mirror image of the NX-loss case: an 'OK' reply means the key is armed, so
    // the row must stay pending (nothing has executed yet).
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls, false, 'OK'),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(1);
    expect(settleOverrideAction).not.toHaveBeenCalled();
  });

  it('charges the tick latency against the re-armed window, not the operator', async () => {
    // The TTL was read before the strategy ran. Re-arming with the raw value would
    // restart the countdown and push the operator's deadline out by one tick on
    // every defer.
    const setCalls: unknown[][] = [];

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction: vi.fn(async () => {}),
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 120_000,
      elapsedMs: 350,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls[0]).toEqual([OVERRIDE_KEY, JSON.stringify(OVERRIDE), 'PX', 119_650, 'NX']);
  });

  // A re-armed override goes back into Redis for a LATER tick to run. If the row it
  // points at is still claimed, that tick cannot claim it (the CAS wants
  // `processing_at is null`) and the operator cannot cancel it either (the delete
  // wants the same): the intent is restored to a row nobody can act on.
  describe('claim release on re-arm', () => {
    it('releases the claim before the key goes back into Redis', async () => {
      // Ordering, not mere occurrence: the moment the key exists again a tick can
      // pick it up, and a release landing after that races the retry's own claim and
      // can clear it. One shared log so a pair of independent spies cannot fake this.
      const calls: string[] = [];
      const setCalls: unknown[][] = [];
      const releaseOverrideClaim = vi.fn(async () => {
        calls.push('release');
      });

      await settleOverride({
        redis: {
          set: (...argv: unknown[]): Promise<'OK'> => {
            calls.push('set');
            setCalls.push(argv);
            return Promise.resolve('OK');
          },
        } as unknown as import('ioredis').Redis,
        logger: buildFakeLogger([]),
        settleOverrideAction: vi.fn(async () => {}),
        releaseOverrideClaim,
        claimAt: CLAIM_AT,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      // Fenced on the stamp: the release can clear this tick's claim and nothing else.
      expect(releaseOverrideClaim).toHaveBeenCalledWith(SCOPE, OVERRIDE_ACTION_ID, CLAIM_AT);
      expect(setCalls).toHaveLength(1);
      expect(calls).toEqual(['release', 'set']);
    });

    it('re-arms anyway when the release fails', async () => {
      // The release runs OUTSIDE the re-arm's try for this reason. Inside, a fault
      // would jump to the "re-arm failed" branch without ever attempting the SET, and
      // the operator's intent would be gone: the key deleted, the row pending, no tick
      // ever retrying. A row whose claim is stuck is recoverable (the stale-claim
      // reaper clears it); a lost force-sell is not.
      const setCalls: unknown[][] = [];
      const warnings: { ctx: unknown; msg: string }[] = [];

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger(warnings),
        settleOverrideAction: vi.fn(async () => {}),
        releaseOverrideClaim: vi.fn(() => Promise.reject(new Error('postgres unreachable'))),
        claimAt: CLAIM_AT,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      expect(setCalls).toHaveLength(1);
      expect(warnings.some((w) => /could not release the override claim/.test(w.msg))).toBe(true);
    });

    it('re-arms anyway when the release stalls past its deadline', async () => {
      // Unbounded, this holds the per-(profile, symbol) chain lock open on a wedged
      // Postgres and the test would time out rather than pass slowly.
      const setCalls: unknown[][] = [];
      const warnings: { ctx: unknown; msg: string }[] = [];

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger(warnings),
        settleOverrideAction: vi.fn(async () => {}),
        releaseOverrideClaim: vi.fn(() => new Promise<void>(() => undefined)),
        claimAt: CLAIM_AT,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        persistTimeoutMs: 20,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      expect(setCalls).toHaveLength(1);
      expect(
        warnings.some((w) => /releasing the override claim exceeded its deadline/.test(w.msg)),
      ).toBe(true);
    });

    it('settles a claimed row terminally when NX refuses the re-arm', async () => {
      // The release already ran, then NX found a newer override in the key. The stale
      // row can never execute now, so it must settle rather than sit pending, and
      // being claimed cannot block that: the settle carries no `processing_at`
      // predicate. Left pending, the operator watches a dead override forever.
      const setCalls: unknown[][] = [];
      const settleOverrideAction = vi.fn(async () => {});
      const releaseOverrideClaim = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls, false, null),
        logger: buildFakeLogger([]),
        settleOverrideAction,
        releaseOverrideClaim,
        claimAt: CLAIM_AT,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      expect(releaseOverrideClaim).toHaveBeenCalledTimes(1);
      expect(settleOverrideAction).toHaveBeenCalledTimes(1);
      expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({ status: 'superseded' });
    });

    it('does not release when it has no stamp to fence the release on', async () => {
      // A caller with no `claimAt` never claimed, so it is entitled to clear nothing.
      // Firing an unfenced release here is the hazard: `processing_at is not null`
      // matches whoever holds the row, so it would strip a claim belonging to someone
      // else and take the cancel guard off a dispatch in flight.
      const setCalls: unknown[][] = [];
      const releaseOverrideClaim = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger([]),
        settleOverrideAction: vi.fn(async () => {}),
        releaseOverrideClaim,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: true,
        supported: true,
        orderFate: { kind: 'none' },
      });

      // The re-arm still happens: the operator's intent does not depend on the claim.
      expect(setCalls).toHaveLength(1);
      expect(releaseOverrideClaim).not.toHaveBeenCalled();
    });

    it('settles an aborted tick that could not confirm its claim, and never re-arms it', async () => {
      // The futility test that keeps an unconfirmable claim from looping: same shape as
      // a deterministic abort, different cause. Nothing was dispatched, so the override
      // provably did not execute and the row can carry a verdict.
      const setCalls: unknown[][] = [];
      const settleOverrideAction = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger([]),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: false,
        orderFate: {
          kind: 'aborted',
          dispatched: false,
          deterministic: false,
          claimUnresolved: true,
        },
      });

      expect(setCalls).toHaveLength(0);
      expect(settleOverrideAction).toHaveBeenCalledTimes(1);
      expect(settleOverrideAction.mock.calls[0]?.[2]).toEqual({
        status: 'rejected',
        reason: 'the bot could not confirm it owned this override; nothing was run, re-issue it',
      });
    });

    it('re-arms the same aborted tick once its claim WAS resolved', async () => {
      // The control for the case above: without it, an assertion that an unresolved
      // claim does not re-arm would also pass if the abort path had stopped re-arming
      // altogether.
      const setCalls: unknown[][] = [];
      const settleOverrideAction = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger([]),
        settleOverrideAction,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: false,
        orderFate: {
          kind: 'aborted',
          dispatched: false,
          deterministic: false,
          claimUnresolved: false,
        },
      });

      expect(setCalls).toHaveLength(1);
      expect(settleOverrideAction).not.toHaveBeenCalled();
    });

    it('does not release when the override is being settled rather than re-armed', async () => {
      // The claim protects a dispatch. A settled row is finished, so there is nothing
      // to protect and nothing to hand back; a release here would be a write whose
      // only effect is to make a consumed row briefly claimable.
      const setCalls: unknown[][] = [];
      const releaseOverrideClaim = vi.fn(async () => {});

      await settleOverride({
        redis: buildFakeRedis(setCalls),
        logger: buildFakeLogger([]),
        settleOverrideAction: vi.fn(async () => {}),
        releaseOverrideClaim,
        claimAt: CLAIM_AT,
        scope: SCOPE,
        symbol: SYMBOL,
        override: OVERRIDE,
        ttlMs: 120_000,
        deferred: false,
        supported: true,
        orderFate: { kind: 'placed' },
      });

      expect(setCalls).toHaveLength(0);
      expect(releaseOverrideClaim).not.toHaveBeenCalled();
    });
  });

  it('consumes without re-arming when the tick outlived the remaining window', async () => {
    const setCalls: unknown[][] = [];
    const settleOverrideAction = vi.fn(async () => {});

    await settleOverride({
      redis: buildFakeRedis(setCalls),
      logger: buildFakeLogger([]),
      settleOverrideAction,
      scope: SCOPE,
      symbol: SYMBOL,
      override: OVERRIDE,
      ttlMs: 200,
      elapsedMs: 200,
      deferred: true,
      supported: true,
      orderFate: { kind: 'none' },
    });

    expect(setCalls).toHaveLength(0);
    expect(settleOverrideAction).toHaveBeenCalledTimes(1);
  });
});
