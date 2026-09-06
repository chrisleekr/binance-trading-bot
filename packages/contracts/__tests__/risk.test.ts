import { describe, expect, it } from 'vitest';
import * as riskModule from '../src/risk.js';
import { RiskConfigSchema, RiskStatus, startOfUtcDayMs, nextUtcMidnightMs } from '../src/risk.js';

// The breaker-kind symbols are read off the module namespace rather than through named imports: a named import of an export that does not exist is a module-link error that kills the whole file, and a file that only ever fails to link would go green against an empty stub. Reading them as values makes every assertion below about a shape, not about whether an import resolved.
const { EntryHaltKind, ENTRY_HALT_REASONS } = riskModule as unknown as {
  EntryHaltKind?: { readonly options?: readonly string[] };
  ENTRY_HALT_REASONS?: Readonly<Record<string, string>>;
};

const OFF_LOSS_STREAK = { maxLosingExits: 0, lookbackHours: 24, pauseHours: 24 };
const OFF_DRAWDOWN = { maxDrawdownQuote: '0', lookbackHours: 72, pauseHours: 24 };

describe('risk UTC-day helpers', () => {
  it('startOfUtcDayMs floors to 00:00 UTC', () => {
    expect(startOfUtcDayMs(Date.UTC(2026, 5, 18, 12, 34, 56))).toBe(Date.UTC(2026, 5, 18));
  });

  it('nextUtcMidnightMs is the following 00:00 UTC', () => {
    expect(nextUtcMidnightMs(Date.UTC(2026, 5, 18, 12, 0, 0))).toBe(Date.UTC(2026, 5, 19));
  });

  it('handles the exact-midnight boundary', () => {
    expect(startOfUtcDayMs(Date.UTC(2026, 5, 18))).toBe(Date.UTC(2026, 5, 18));
    expect(nextUtcMidnightMs(Date.UTC(2026, 5, 18))).toBe(Date.UTC(2026, 5, 19));
  });
});

describe('EntryHaltKind', () => {
  it('enumerates the three breakers in the order every reader reports them', () => {
    expect(EntryHaltKind?.options).toEqual(['daily-loss', 'loss-streak', 'drawdown']);
  });
});

describe('ENTRY_HALT_REASONS', () => {
  it('carries one operator sentence per kind', () => {
    expect(Object.keys(ENTRY_HALT_REASONS ?? {})).toEqual([
      'daily-loss',
      'loss-streak',
      'drawdown',
    ]);
  });

  it('gives each kind a distinct non-empty sentence', () => {
    const sentences = Object.values(ENTRY_HALT_REASONS ?? {});
    expect(sentences).toHaveLength(3);
    expect(sentences.every((s) => typeof s === 'string' && s.trim().length > 0)).toBe(true);
    // Distinct, because the whole point of a per-kind sentence is that the operator can tell which breaker refused the buy.
    expect(new Set(sentences).size).toBe(3);
  });
});

describe('RiskConfigSchema', () => {
  it('shapes all three blocks with every guard off on empty input', () => {
    expect(RiskConfigSchema.parse({})).toEqual({
      dailyLossLimitQuote: '0',
      lossStreak: OFF_LOSS_STREAK,
      drawdown: OFF_DRAWDOWN,
    });
  });

  it('leaves a stored daily-only row behaving exactly as today', () => {
    expect(RiskConfigSchema.parse({ dailyLossLimitQuote: '9' })).toEqual({
      dailyLossLimitQuote: '9',
      lossStreak: OFF_LOSS_STREAK,
      drawdown: OFF_DRAWDOWN,
    });
  });

  it('accepts a non-negative decimal limit', () => {
    expect(RiskConfigSchema.parse({ dailyLossLimitQuote: '25' }).dailyLossLimitQuote).toBe('25');
  });

  it('rejects a negative limit', () => {
    expect(RiskConfigSchema.safeParse({ dailyLossLimitQuote: '-5' }).success).toBe(false);
  });

  it('accepts a configured loss-streak guard and fills its pause', () => {
    expect(
      RiskConfigSchema.parse({ lossStreak: { maxLosingExits: 3, lookbackHours: 24 } }).lossStreak,
    ).toEqual({ maxLosingExits: 3, lookbackHours: 24, pauseHours: 24 });
  });

  it('accepts a configured drawdown guard and fills its pause', () => {
    expect(
      RiskConfigSchema.parse({ drawdown: { maxDrawdownQuote: '15', lookbackHours: 72 } }).drawdown,
    ).toEqual({ maxDrawdownQuote: '15', lookbackHours: 72, pauseHours: 24 });
  });

  it('rejects out-of-range or fractional loss-streak windows', () => {
    expect(RiskConfigSchema.safeParse({ lossStreak: { lookbackHours: 0 } }).success).toBe(false);
    expect(RiskConfigSchema.safeParse({ lossStreak: { lookbackHours: 169 } }).success).toBe(false);
    expect(RiskConfigSchema.safeParse({ lossStreak: { lookbackHours: 1.5 } }).success).toBe(false);
    expect(RiskConfigSchema.safeParse({ lossStreak: { pauseHours: 0 } }).success).toBe(false);
  });

  it('rejects an out-of-range drawdown window and a negative drawdown limit', () => {
    expect(RiskConfigSchema.safeParse({ drawdown: { lookbackHours: 169 } }).success).toBe(false);
    expect(RiskConfigSchema.safeParse({ drawdown: { maxDrawdownQuote: '-1' } }).success).toBe(
      false,
    );
  });
});

describe('RiskStatus', () => {
  it('carries the kinds that are pausing buys', () => {
    expect(
      RiskStatus.parse({
        halted: true,
        haltKinds: ['loss-streak'],
        todayRealizedPnl: '-3',
        limitQuote: null,
        resetsAtMs: 123,
      }),
    ).toEqual({
      halted: true,
      haltKinds: ['loss-streak'],
      todayRealizedPnl: '-3',
      limitQuote: null,
      resetsAtMs: 123,
    });
  });

  it('rejects a halt kind that is not a breaker', () => {
    expect(
      RiskStatus.safeParse({
        halted: true,
        haltKinds: ['not-a-breaker'],
        todayRealizedPnl: '-3',
        limitQuote: null,
        resetsAtMs: 123,
      }).success,
    ).toBe(false);
  });
});
