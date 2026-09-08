import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { entryHaltKeys } from '@app/db';

import {
  claimGuardHalt,
  isDailyLossBreached,
  isDrawdownTripped,
  isLossStreakTripped,
  portfolioRiskHandler,
  resolveRiskWindows,
  type DrawdownAssessment,
  type LossStreakAssessment,
  type PortfolioRiskDeps,
  type RiskAssessment,
} from '../../src/crons/portfolio-risk.cron.js';

const silent = pino({ level: 'silent' });
const U = 'u1' as unknown as UserId;
const A = 'a1' as unknown as AccountId;
const P = 'p1' as unknown as ProfileId;
const job = {} as Job;
// 12:00 UTC on 2026-06-18 → start-of-day at 00:00, 12h (43200s) to next midnight.
const NOON = Date.UTC(2026, 5, 18, 12, 0, 0);

describe('isDailyLossBreached', () => {
  it('is off when the limit is 0, blank, or non-positive', () => {
    expect(isDailyLossBreached('-100', '0')).toBe(false);
    expect(isDailyLossBreached('-100', '')).toBe(false);
    expect(isDailyLossBreached('-100', '-5')).toBe(false);
  });

  it('is not breached when the loss is under the limit (or a profit)', () => {
    expect(isDailyLossBreached('-4.99', '5')).toBe(false);
    expect(isDailyLossBreached('10', '5')).toBe(false);
  });

  it('is breached when the loss meets or exceeds the limit', () => {
    expect(isDailyLossBreached('-5', '5')).toBe(true);
    expect(isDailyLossBreached('-7.5', '5')).toBe(true);
  });

  it('fails safe (not breached) on malformed input', () => {
    expect(isDailyLossBreached('abc', '5')).toBe(false);
    expect(isDailyLossBreached('-5', 'abc')).toBe(false);
  });
});

// `daily`-only assessment in the new three-breaker shape, so the daily cases below still read as one-line intents.
const dailyOnly = (limitQuote: string, realisedPnl: string): RiskAssessment => ({
  daily: { limitQuote, realisedPnl },
  lossStreak: null,
  drawdown: null,
});

const streak = (over: Partial<LossStreakAssessment> = {}): LossStreakAssessment => ({
  maxLosingExits: 3,
  losingExits: 3,
  lookbackHours: 24,
  pauseHours: 24,
  ...over,
});

const dd = (over: Partial<DrawdownAssessment> = {}): DrawdownAssessment => ({
  maxDrawdownQuote: '15',
  drawdownQuote: '15',
  lookbackHours: 72,
  pauseHours: 24,
  ...over,
});

const deps = (over: Partial<PortfolioRiskDeps> = {}): PortfolioRiskDeps => ({
  logger: silent,
  listActive: () => [{ operatorId: U, accountId: A, profileId: P } as never],
  assess: vi.fn(async () => null),
  setEntryHalt: vi.fn(async () => undefined),
  wasHalted: vi.fn(async () => false),
  // Throws rather than resolving false: a guard that is OFF must never reach this
  // dep at all, and a stub that quietly answers "already running" would let a
  // never-off guard pass every one of the off cases below.
  setGuardHalt: vi.fn(async () => {
    throw new Error('setGuardHalt must not be called when no guard has tripped');
  }),
  notify: vi.fn(async () => undefined),
  clock: { nowMs: () => NOON },
  ...over,
});

describe('portfolioRiskHandler', () => {
  it('does not halt when the breaker is off (assess returns null)', async () => {
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(deps({ assess: async () => null, setEntryHalt }))(job);
    expect(setEntryHalt).not.toHaveBeenCalled();
  });

  it('does not halt when the loss is under the limit', async () => {
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(deps({ assess: async () => dailyOnly('5', '-3'), setEntryHalt }))(
      job,
    );
    expect(setEntryHalt).not.toHaveBeenCalled();
  });

  it('halts with a TTL to the next UTC midnight when breached', async () => {
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(deps({ assess: async () => dailyOnly('5', '-6'), setEntryHalt }))(
      job,
    );
    expect(setEntryHalt).toHaveBeenCalledTimes(1);
    const call = setEntryHalt.mock.calls[0] as unknown as [AccountId, ProfileId, number, string];
    expect(call[0]).toBe(A);
    expect(call[1]).toBe(P);
    expect(call[2]).toBe(43_200);
    expect(JSON.parse(call[3])).toMatchObject({
      reason: 'daily-loss-limit',
      limitQuote: '5',
      lossQuote: '-6',
    });
  });

  it('notifies the operator on the transition into halt', async () => {
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => dailyOnly('5', '-6'),
        wasHalted: async () => false,
        notify,
      }),
    )(job);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      category: 'daily-loss-halt',
      operatorId: U,
      accountId: A,
      profileId: P,
    });
  });

  it('does not re-notify while already halted (but still re-sets the flag)', async () => {
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => dailyOnly('5', '-6'),
        wasHalted: async () => true,
        setEntryHalt,
        notify,
      }),
    )(job);
    expect(setEntryHalt).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('assesses at the cycle instant, which every window is derived from', async () => {
    const assess = vi.fn(async () => null);
    await portfolioRiskHandler(deps({ assess }))(job);
    const call = assess.mock.calls[0] as unknown as [UserId, AccountId, ProfileId, number];
    expect(call[3]).toBe(NOON);
  });
});

describe('resolveRiskWindows', () => {
  it('derives the daily window from the UTC day, not from the lookbacks', () => {
    const w = resolveRiskWindows({ dailyLossLimitQuote: '5' }, NOON);
    expect(w.daily).toEqual({
      limitQuote: '5',
      fromMs: Date.UTC(2026, 5, 18),
      toMs: NOON,
    });
  });

  it('derives each guard window from its own lookback in hours', () => {
    const w = resolveRiskWindows(
      {
        lossStreak: { maxLosingExits: 3, lookbackHours: 24, pauseHours: 6 },
        drawdown: { maxDrawdownQuote: '15', lookbackHours: 72, pauseHours: 12 },
      },
      NOON,
    );
    // Hours, not minutes or seconds: a unit slip here narrows the window to
    // nothing and the guard silently never trips again.
    expect(w.lossStreak).toEqual({
      maxLosingExits: 3,
      lookbackHours: 24,
      pauseHours: 6,
      fromMs: NOON - 24 * 3_600_000,
      toMs: NOON,
    });
    expect(w.drawdown).toEqual({
      maxDrawdownQuote: '15',
      lookbackHours: 72,
      pauseHours: 12,
      fromMs: NOON - 72 * 3_600_000,
      toMs: NOON,
    });
  });

  it('leaves every breaker off for a stored config that predates the guards', () => {
    expect(resolveRiskWindows({ dailyLossLimitQuote: '0' }, NOON)).toEqual({
      daily: null,
      lossStreak: null,
      drawdown: null,
    });
    // The exact live row shape before this shipped: a daily limit and nothing else.
    const stored = resolveRiskWindows({ dailyLossLimitQuote: '9' }, NOON);
    expect(stored.daily?.limitQuote).toBe('9');
    expect(stored.lossStreak).toBeNull();
    expect(stored.drawdown).toBeNull();
  });

  it('disables every breaker when the stored config does not validate', () => {
    // Fail-open on the breaker, never a throw inside the cron loop.
    expect(resolveRiskWindows({ dailyLossLimitQuote: 'not-a-number' }, NOON)).toEqual({
      daily: null,
      lossStreak: null,
      drawdown: null,
    });
  });
});

describe('isLossStreakTripped', () => {
  it('trips at exactly the configured count, not one before it', () => {
    expect(isLossStreakTripped(streak({ losingExits: 2 }))).toBe(false);
    expect(isLossStreakTripped(streak({ losingExits: 3 }))).toBe(true);
    expect(isLossStreakTripped(streak({ losingExits: 4 }))).toBe(true);
  });

  it('is off at 0, whatever the window holds', () => {
    expect(isLossStreakTripped(streak({ maxLosingExits: 0, losingExits: 50 }))).toBe(false);
  });
});

describe('isDrawdownTripped', () => {
  it('trips when the drawdown REACHES the limit', () => {
    // Equality is the case that matters: every "does not trip" case below also
    // passes against a predicate hard-wired to false, and only this one does not.
    expect(isDrawdownTripped(dd({ drawdownQuote: '15', maxDrawdownQuote: '15' }))).toBe(true);
    expect(isDrawdownTripped(dd({ drawdownQuote: '15.01' }))).toBe(true);
  });

  it('does not trip below the limit', () => {
    expect(isDrawdownTripped(dd({ drawdownQuote: '14.99' }))).toBe(false);
  });

  it('is off at a zero or negative limit', () => {
    expect(isDrawdownTripped(dd({ maxDrawdownQuote: '0', drawdownQuote: '100' }))).toBe(false);
    expect(isDrawdownTripped(dd({ maxDrawdownQuote: '-1', drawdownQuote: '100' }))).toBe(false);
  });

  it('fails safe on malformed input, as the daily breaker does', () => {
    expect(isDrawdownTripped(dd({ drawdownQuote: 'abc' }))).toBe(false);
    expect(isDrawdownTripped(dd({ maxDrawdownQuote: 'abc' }))).toBe(false);
  });
});

describe('portfolioRiskHandler loss guards', () => {
  it('sets the loss-streak flag with a TTL of pauseHours and the trip payload', async () => {
    const setGuardHalt = vi.fn(async () => true);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({
          daily: null,
          lossStreak: streak({ pauseHours: 6, losingExits: 3 }),
          drawdown: null,
        }),
        setGuardHalt,
      }),
    )(job);
    expect(setGuardHalt).toHaveBeenCalledTimes(1);
    const call = setGuardHalt.mock.calls[0] as unknown as [
      AccountId,
      ProfileId,
      string,
      number,
      string,
    ];
    expect(call[0]).toBe(A);
    expect(call[1]).toBe(P);
    expect(call[2]).toBe('loss-streak');
    expect(call[3]).toBe(6 * 3600);
    expect(JSON.parse(call[4])).toMatchObject({
      reason: 'loss-streak',
      losingExits: 3,
      maxLosingExits: 3,
      lookbackHours: 24,
      trippedAtMs: NOON,
      resumesAtMs: NOON + 6 * 3600 * 1000,
    });
  });

  it('sets the drawdown flag with its own kind, TTL, and payload', async () => {
    const setGuardHalt = vi.fn(async () => true);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({ daily: null, lossStreak: null, drawdown: dd({ pauseHours: 12 }) }),
        setGuardHalt,
      }),
    )(job);
    const call = setGuardHalt.mock.calls[0] as unknown as [
      AccountId,
      ProfileId,
      string,
      number,
      string,
    ];
    expect(call[2]).toBe('drawdown');
    expect(call[3]).toBe(12 * 3600);
    expect(JSON.parse(call[4])).toMatchObject({
      reason: 'drawdown',
      drawdownQuote: '15',
      maxDrawdownQuote: '15',
      lookbackHours: 72,
    });
  });

  it('does not touch the flag when a guard is configured but has not tripped', async () => {
    // Non-invocation is the assertion, not a stubbed "no": a stub that resolves
    // false would make an always-tripping guard pass this, because the notify
    // gate would swallow it. The throwing stub also proves the dep is not
    // reached on a path whose error the fan-out would otherwise collect.
    const setGuardHalt = vi.fn(async () => {
      throw new Error('setGuardHalt must not be called when no guard has tripped');
    });
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({
          daily: null,
          lossStreak: streak({ losingExits: 2 }),
          drawdown: dd({ drawdownQuote: '14.99' }),
        }),
        setGuardHalt,
        notify,
      }),
    )(job);
    expect(setGuardHalt).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('stays silent when the pause was ALREADY running (SET NX lost the race)', async () => {
    // The 30 s cron re-evaluates a tripped guard ~2,880 times over a 24 h pause.
    // Notifying on anything but the creating call turns one pause into a flood.
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    const metrics = { record: vi.fn() };
    await portfolioRiskHandler(
      deps({
        assess: async () => ({ daily: null, lossStreak: streak(), drawdown: null }),
        setGuardHalt: vi.fn(async () => false),
        notify,
        metrics: metrics as unknown as NonNullable<PortfolioRiskDeps['metrics']>,
      }),
    )(job);
    expect(notify).not.toHaveBeenCalled();
    expect(metrics.record).not.toHaveBeenCalled();
  });

  it('notifies and counts the trip on the call that created the flag', async () => {
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    const metrics = { record: vi.fn() };
    await portfolioRiskHandler(
      deps({
        assess: async () => ({ daily: null, lossStreak: null, drawdown: dd() }),
        setGuardHalt: vi.fn(async () => true),
        notify,
        metrics: metrics as unknown as NonNullable<PortfolioRiskDeps['metrics']>,
      }),
    )(job);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      category: 'loss-guard-halt',
      operatorId: U,
      accountId: A,
      profileId: P,
    });
    expect(metrics.record).toHaveBeenCalledWith('portfolio_risk_halt_total', 1, {
      kind: 'drawdown',
    });
  });

  it('strips the numeric column scale off the drawdown alert, on both of its money fields', async () => {
    // `drawdownQuote` is not operator-typed: it is the `::text` of a
    // `numeric(38,18)`, so it arrives carrying the column's full scale and lands
    // in the alert directly beside a limit the operator typed themselves. Left
    // raw, "Drawdown 15.388000000000000000" sits under "Limit 15" and reads as a
    // different kind of number. The limit goes through the same normaliser for
    // the same reason the daily alert's does: normalising one field and not its
    // neighbour is how two figures on one surface come to be formatted two
    // different ways.
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({
          daily: null,
          lossStreak: null,
          drawdown: dd({ drawdownQuote: '15.388000000000000000', maxDrawdownQuote: '15.00' }),
        }),
        setGuardHalt: vi.fn(async () => true),
        notify,
      }),
    )(job);

    const fields = (
      notify.mock.calls[0]?.[0] as unknown as { fields: { label: string; value: string }[] }
    ).fields;
    const valueOf = (label: string) => fields.find((f) => f.label === label)?.value;
    expect(valueOf('Drawdown')).toBe('15.388');
    expect(valueOf('Limit')).toBe('15');
  });

  it('renders a tiny daily loss as plain decimal, never in exponential form', async () => {
    // decimal.js switches `toString` to exponential at small exponents, so a
    // BTC-quoted profile's real 0.00000015 loss reached the operator as `1.5e-7`
    // — which in a currency field reads as corruption, not as a small number.
    // Both fields go through the same normaliser: formatting one and not its
    // neighbour puts two figures on one alert in two different notations.
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    await portfolioRiskHandler(
      deps({ assess: async () => dailyOnly('0.00000010', '-0.00000015'), notify }),
    )(job);

    const fields = (
      notify.mock.calls[0]?.[0] as unknown as { fields: { label: string; value: string }[] }
    ).fields;
    const valueOf = (label: string) => fields.find((f) => f.label === label)?.value;
    expect(valueOf("Today's loss")).toBe('0.00000015');
    // The limit is normalised too, so a stored trailing-zero scale does not sit
    // beside an already-normalised loss.
    expect(valueOf('Limit')).toBe('0.0000001');
    for (const f of fields) expect(f.value).not.toMatch(/e[+-]/i);
  });

  it('does not expand an extreme-exponent limit into a multi-megabyte alert field', async () => {
    // `dailyLossLimitQuote` is operator-typed and validated only for decimal
    // shape, finiteness and `gte: 0` — nothing bounds its exponent — so twelve
    // stored bytes reach the alert path intact. Spelled out by `toFixed()` they
    // become ten million characters, built synchronously on the single-replica
    // worker's event loop and then POSTed to the notifier and written to
    // notification history. The exponential spelling is the point: it is a
    // presentation fallback, and the comparison that tripped the breaker and
    // the payload stored on the flag both used the exact value either way.
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    await portfolioRiskHandler(
      deps({ assess: async () => dailyOnly('1e-10000000', '-1e-10000000'), notify }),
    )(job);

    const fields = (
      notify.mock.calls[0]?.[0] as unknown as { fields: { label: string; value: string }[] }
    ).fields;
    expect(fields).toHaveLength(2);
    for (const f of fields) {
      expect(f.value).toBe('1e-10000000');
      expect(f.value.length).toBeLessThan(64);
    }
  });

  it('switches spelling at exactly one exponent, not somewhere in the seven decades either side', async () => {
    // The two cases above sit at exponents -7 and -10000000, so both stay green for any threshold between them and for either comparison operator. These two are the adjacent pair: 1e-308 is the last amount that must still be spelled out in full and 1e-309 the first that must not, which pins the number and the `<=` together. Moving the threshold down breaks the first assertion, moving it up breaks the second, and tightening `<=` to `<` breaks the first.
    const lossField = async (amount: string): Promise<string | undefined> => {
      const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
      await portfolioRiskHandler(
        deps({ assess: async () => dailyOnly(amount, `-${amount}`), notify }),
      )(job);
      const fields = (
        notify.mock.calls[0]?.[0] as unknown as { fields: { label: string; value: string }[] }
      ).fields;
      return fields.find((f) => f.label === "Today's loss")?.value;
    };

    expect(await lossField('1e-308')).toBe(`0.${'0'.repeat(307)}1`);
    expect(await lossField('1e-309')).toBe('1e-309');
  });

  it('does not expand a long-MANTISSA limit either, which the exponent gate cannot see', async () => {
    // The other axis of the same expansion. `'1.' + '9'.repeat(...)` has an exponent of 0, so an exponent-only gate spells it out in full, and a bare `toExponential()` fallback writes every significant digit too: the digit count is what has to be capped, by rounding. The stored value is untouched, exactly as on the exponent path, so the comparison that tripped the breaker and the flag payload both still used it exact.
    const notify = vi.fn<PortfolioRiskDeps['notify']>(async () => undefined);
    const long = `1.${'9'.repeat(2_000)}`;
    await portfolioRiskHandler(deps({ assess: async () => dailyOnly(long, `-${long}`), notify }))(
      job,
    );

    const fields = (
      notify.mock.calls[0]?.[0] as unknown as { fields: { label: string; value: string }[] }
    ).fields;
    expect(fields).toHaveLength(2);
    for (const f of fields) {
      expect(f.value.length).toBeLessThan(400);
      expect(f.value).toMatch(/e[+-]/i);
    }
  });

  it('counts the daily breaker under the same metric, so no kind is structurally dead', async () => {
    const metrics = { record: vi.fn() };
    await portfolioRiskHandler(
      deps({
        assess: async () => dailyOnly('5', '-6'),
        metrics: metrics as unknown as NonNullable<PortfolioRiskDeps['metrics']>,
      }),
    )(job);
    expect(metrics.record).toHaveBeenCalledWith('portfolio_risk_halt_total', 1, {
      kind: 'daily-loss',
    });
  });

  it('trips all three breakers in one cycle', async () => {
    const setEntryHalt = vi.fn(async () => undefined);
    const setGuardHalt = vi.fn(async () => true);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({
          daily: { limitQuote: '5', realisedPnl: '-6' },
          lossStreak: streak(),
          drawdown: dd(),
        }),
        setEntryHalt,
        setGuardHalt,
      }),
    )(job);
    expect(setEntryHalt).toHaveBeenCalledTimes(1);
    expect(setGuardHalt.mock.calls.map((c) => (c as unknown as string[])[2])).toEqual([
      'loss-streak',
      'drawdown',
    ]);
  });
});

describe('claimGuardHalt', () => {
  // A fake that records every argument list and answers 'OK' once, then null —
  // Redis's own two answers for SET NX: the call that wrote, and every later
  // call that found a pause already running.
  const fakeRedis = () => {
    const calls: unknown[][] = [];
    const replies: (string | null)[] = ['OK', null];
    return {
      calls,
      redis: {
        set: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(replies.shift() ?? null);
        },
      } as unknown as Pick<Redis, 'set'>,
    };
  };

  it('sets the guard key NX with the pause TTL', async () => {
    const { calls, redis } = fakeRedis();
    const key = entryHaltKeys({ accountId: A, profileId: P })['loss-streak'];

    await claimGuardHalt(redis, key, 86_400, '{"reason":"loss-streak"}');

    // The literal argument list, not just the outcome: 'NX' is the whole
    // invariant, and dropping it leaves every other assertion here green while
    // a 24 h pause becomes 2,880 alerts.
    expect(calls[0]).toEqual([key, '{"reason":"loss-streak"}', 'EX', 86_400, 'NX']);
  });

  it("reports created only for the call Redis answered 'OK'", async () => {
    const { redis } = fakeRedis();
    const key = entryHaltKeys({ accountId: A, profileId: P }).drawdown;

    // First call wins the key; the cycle 30s later loses the NX race and gets
    // null, which is the normal "a pause is in flight" answer and must read as
    // "not created" so the caller stays silent.
    expect(await claimGuardHalt(redis, key, 3_600, 'v1')).toBe(true);
    expect(await claimGuardHalt(redis, key, 3_600, 'v1')).toBe(false);
  });
});
