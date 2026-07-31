import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Job } from 'bullmq';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

import {
  isDailyLossBreached,
  portfolioRiskHandler,
  type PortfolioRiskDeps,
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

const deps = (over: Partial<PortfolioRiskDeps> = {}): PortfolioRiskDeps => ({
  logger: silent,
  listActive: () => [{ operatorId: U, accountId: A, profileId: P } as never],
  assess: vi.fn(async () => null),
  setEntryHalt: vi.fn(async () => undefined),
  wasHalted: vi.fn(async () => false),
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
    await portfolioRiskHandler(
      deps({ assess: async () => ({ limitQuote: '5', realisedPnl: '-3' }), setEntryHalt }),
    )(job);
    expect(setEntryHalt).not.toHaveBeenCalled();
  });

  it('halts with a TTL to the next UTC midnight when breached', async () => {
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(
      deps({ assess: async () => ({ limitQuote: '5', realisedPnl: '-6' }), setEntryHalt }),
    )(job);
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
    const notify = vi.fn(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({ limitQuote: '5', realisedPnl: '-6' }),
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
    const notify = vi.fn(async () => undefined);
    const setEntryHalt = vi.fn(async () => undefined);
    await portfolioRiskHandler(
      deps({
        assess: async () => ({ limitQuote: '5', realisedPnl: '-6' }),
        wasHalted: async () => true,
        setEntryHalt,
        notify,
      }),
    )(job);
    expect(setEntryHalt).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('assesses against the UTC start-of-day window', async () => {
    const assess = vi.fn(async () => null);
    await portfolioRiskHandler(deps({ assess }))(job);
    const call = assess.mock.calls[0] as unknown as [UserId, AccountId, ProfileId, number, number];
    expect(call[3]).toBe(Date.UTC(2026, 5, 18));
    expect(call[4]).toBe(NOON);
  });
});
