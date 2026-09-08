import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { atrTrailingStopPrice, initialStopDistanceFraction } from '../src/trailing-stop.js';
import { MomentumConfigSchema, type MomentumConfig } from '../src/index.js';

const mkCandles = (closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    ...over,
  });

// Closes with high=low=close, so ATR reduces to the mean absolute close-to-close
// move: TRs 2,1,3,1,2 -> Wilder ATR(3) ≈ 1.7778.
const CANDLES = mkCandles(['10', '12', '11', '14', '13', '15']);
const HIGH = new Decimal('15');

describe('atrTrailingStopPrice', () => {
  it('returns null when the ATR mode is off or absent', () => {
    expect(atrTrailingStopPrice(cfg(), CANDLES, HIGH)).toBeNull();
    expect(
      atrTrailingStopPrice(cfg({ atrTrailingStop: { enabled: false } }), CANDLES, HIGH),
    ).toBeNull();
  });

  it('returns effectiveHigh minus multiple*ATR when enabled and computable', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } });
    const expected = HIGH.minus(new Decimal('2').times(atr(CANDLES, 3)));
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)?.toString()).toBe(expected.toString());
  });

  it('returns null when the window is shorter than period+1 (caller falls back to fixed)', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 10 } });
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
  });

  it('returns null when the resulting stop is non-positive', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '1000' } });
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
  });

  it('coerces unparsed period and multiple to their defaults', () => {
    const expected3 = HIGH.minus(new Decimal('3').times(atr(CANDLES, 3))).toString();
    // multiple omitted / malformed / non-positive -> 3.
    for (const multiple of [undefined, 'abc', '0']) {
      const config = {
        ...cfg(),
        atrTrailingStop: {
          enabled: true,
          period: 3,
          ...(multiple === undefined ? {} : { multiple }),
        },
      } as unknown as MomentumConfig;
      expect(atrTrailingStopPrice(config, CANDLES, HIGH)?.toString()).toBe(expected3);
    }
    // period omitted (-> 14), finite-but-<2 (-> 14), or unparseable NaN (-> 14):
    // the 6-candle window is too short for the default 14.
    for (const period of [undefined, 1, 'abc']) {
      const config = {
        ...cfg(),
        atrTrailingStop: {
          enabled: true,
          multiple: '2',
          ...(period === undefined ? {} : { period }),
        },
      } as unknown as MomentumConfig;
      expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
    }
  });
});

// A flat series has zero true range, so ATR is exactly 0 and the distance collapses.
const FLAT = mkCandles(['10', '10', '10', '10']);
const PRICE = new Decimal('100');

describe('initialStopDistanceFraction', () => {
  it('returns null for a non-positive price', () => {
    // The price is the divisor of the ATR branch and the scale the fraction is quoted against; without it there is no distance to resolve, in either branch.
    expect(initialStopDistanceFraction(cfg(), CANDLES, new Decimal(0))).toBeNull();
  });

  it('returns the fixed trailingStopPct when the ATR block is absent', () => {
    expect(
      initialStopDistanceFraction(cfg({ trailingStopPct: '0.07' }), CANDLES, PRICE)?.toString(),
    ).toBe('0.07');
  });

  it('returns the fixed trailingStopPct when the ATR block is present but disabled', () => {
    // A stored-but-off block is a different input from an absent one, and only the `enabled !== true` disjunct covers it.
    const config = cfg({ trailingStopPct: '0.07', atrTrailingStop: { enabled: false } });
    expect(initialStopDistanceFraction(config, CANDLES, PRICE)?.toString()).toBe('0.07');
  });

  it('returns multiple*ATR/price when the ATR mode is on and computable', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } });
    const expected = new Decimal('2').times(atr(CANDLES, 3)).div(PRICE);
    expect(initialStopDistanceFraction(config, CANDLES, PRICE)?.toString()).toBe(
      expected.toString(),
    );
  });

  it('returns null when the ATR window is shorter than period+1', () => {
    // ATR(6) needs 7 candles; CANDLES has 6. No fallback to the fixed pct here: the operator asked for the ATR distance, so an unresolvable one must stay unresolved rather than silently size off a different rule.
    const config = cfg({ atrTrailingStop: { enabled: true, period: 6, multiple: '2' } });
    expect(initialStopDistanceFraction(config, CANDLES, PRICE)).toBeNull();
  });

  it('returns null when the ATR is zero, so the distance would be zero', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } });
    expect(atr(FLAT, 3).toString()).toBe('0');
    expect(initialStopDistanceFraction(config, FLAT, PRICE)).toBeNull();
  });

  it('returns null when the ATR distance reaches or exceeds the price', () => {
    // ATR(3) on CANDLES is ~1.78, so a 100x multiple puts the stop distance above the entry price itself, which is not a fraction of equity anyone can risk-size against.
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '100' } });
    expect(initialStopDistanceFraction(config, CANDLES, PRICE)).toBeNull();
  });

  it('returns null when the fixed trailingStopPct is absent, zero, or at/above one', () => {
    // The parsed schema always defaults and bounds this field, but the live worker reads stored config unparsed, so the guard has to hold against values the schema would have rejected.
    for (const trailingStopPct of [undefined, '', '0', '1', '1.5']) {
      const config = {
        ...cfg(),
        trailingStopPct,
      } as unknown as MomentumConfig;
      expect(initialStopDistanceFraction(config, CANDLES, PRICE)).toBeNull();
    }
  });
});
