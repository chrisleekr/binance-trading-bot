import { describe, expect, it } from 'vitest';
import { RiskConfigSchema, startOfUtcDayMs, nextUtcMidnightMs } from '../src/risk.js';

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

describe('RiskConfigSchema', () => {
  it('defaults the daily loss limit to 0 (off) on empty input', () => {
    expect(RiskConfigSchema.parse({})).toEqual({ dailyLossLimitQuote: '0' });
  });

  it('accepts a non-negative decimal limit', () => {
    expect(RiskConfigSchema.parse({ dailyLossLimitQuote: '25' }).dailyLossLimitQuote).toBe('25');
  });

  it('rejects a negative limit', () => {
    expect(RiskConfigSchema.safeParse({ dailyLossLimitQuote: '-5' }).success).toBe(false);
  });
});
